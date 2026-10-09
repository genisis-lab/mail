import { beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/server/db/index';
import { ingest } from '../src/server/mail/ingest';
import { findParcel, siteOf } from '../src/server/mail/parcel';
import { harness } from './harness';

const h = harness();
const PW = 'a very long password';
const UPS = '1ZA0T5770319884736'; // a valid UPS number (check digit 6)
const OCT_5 = Date.UTC(2026, 9, 5, 15); // Monday
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

let n = 0;
const receive = (opts: { from: string; subject: string; text?: string; html?: string; date?: number; verdicts?: Record<string, string> }) => {
  const id = `<p${++n}.${Date.now()}@shop.example>`;
  const boundary = `b${n}`;
  const body = opts.html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', opts.text ?? '', `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', opts.html, `--${boundary}--`]
    : ['Content-Type: text/plain; charset=utf-8', '', opts.text ?? ''];
  const raw = [`From: ${opts.from}`, 'To: Ada Admin <admin@wren.test>', `Subject: ${opts.subject}`, `Message-ID: ${id}`, `Date: ${new Date(opts.date ?? Date.now() - 3600_000 + n * 1000).toUTCString()}`, 'MIME-Version: 1.0', ...body, ''].join('\r\n');
  return ingest(Buffer.from(raw), { rcptTo: ['admin@wren.test'], source: 'resend', verdicts: opts.verdicts }).then(() => get<any>('SELECT * FROM messages WHERE message_id = ?', [id.slice(1, -1)])!);
};
const thread = async (threadId: number) => (await h.call('GET', `/api/mail/threads/${threadId}`)).body;
const inbox = async () => (await h.call('GET', '/api/mail/threads?view=inbox')).body.threads as any[];

beforeAll(async () => {
  await h.setup();
  await h.login('admin@wren.test', PW);
});

describe('finding a package in an email', () => {
  it('reads a forwarder’s update with a UPS number', () => {
    const f = findParcel({
      subject: 'Package Status Update',
      text: `Hi Ada,\nYour package from Macy's is ready for pickup at our Kingston branch.\nTracking number: ${UPS}\nThanks for shipping with SendX!`,
      html: null,
      from: { address: 'updates@sendxja.com', name: 'SendX Jamaica LTD.' },
      date: OCT_5,
    });
    expect(f).toMatchObject({ site: 'sendxja.com', tracking: UPS, carrier: 'ups', status: 'ready_for_pickup', merchant: 'SendX Jamaica LTD.' });
  });

  it('reads a shop’s shipping email: order, item, links on its own site', () => {
    const f = findParcel({
      subject: `Shipped: "Warner's Women's No Pinching No Problems Lace Hipster Underwear 5609J" and 5 more items`,
      text: null,
      html: `<p>Good news! Your order has shipped.</p><p>Order Number: 4795458681</p>
        <a href="https://www.ups.com/track?loc=en_US&amp;tracknum=${UPS}">Track your package</a>
        <a href="https://click.em.macys.com/?qs=abc123">View order details</a>
        <a href="https://evil.example/steal">View order</a>`,
      from: { address: 'CustomerService@oes.macys.com', name: "Macy's" },
      date: OCT_5,
    });
    expect(f).toMatchObject({
      site: 'macys.com',
      status: 'shipped',
      order: '4795458681',
      tracking: UPS,
      carrier: 'ups',
      item: "Warner's Women's No Pinching No Problems Lace Hipster Underwear 5609J",
      items: 6,
      orderUrl: 'https://click.em.macys.com/?qs=abc123',
    });
    expect(f?.merchant).toBeUndefined(); // a shop we know: named by its site
  });

  it('finds tracking numbers in carrier links, even inside a click tracker', () => {
    const f = findParcel({
      subject: 'Your order is on the way',
      text: null,
      html: `<a href="https://links.shop.example/c?u=${encodeURIComponent('https://www.fedex.com/fedextrack/?trknbr=771234567890')}">771234567890</a>`,
      from: { address: 'orders@shop.example', name: 'Shop' },
      date: OCT_5,
    });
    expect(f).toMatchObject({ tracking: '771234567890', carrier: 'fedex', status: 'in_transit' });
  });

  it('knows USPS, Amazon, international post and FedEx by name', () => {
    const at = (text: string) => findParcel({ subject: 'Shipping update', text, html: null, from: { address: 'no-reply@store.example' }, date: OCT_5 });
    expect(at('USPS tracking: 9400 1118 9922 3456 7890 17')).toMatchObject({ tracking: '9400111899223456789017', carrier: 'usps' });
    expect(at('Your package TBA123456789012 is on its way')).toMatchObject({ tracking: 'TBA123456789012', carrier: 'amazon' });
    expect(at('Sent with Royal Mail, number RR123456785GB')).toMatchObject({ tracking: 'RR123456785GB', carrier: 'royalmail' });
    expect(at('Shipped with FedEx. Your number is 771234567890.')).toMatchObject({ tracking: '771234567890', carrier: 'fedex' });
  });

  it('reads Gmail’s order markup (schema.org)', () => {
    const ld = {
      '@context': 'http://schema.org',
      '@type': 'ParcelDelivery',
      carrier: { '@type': 'Organization', name: 'FedEx' },
      trackingNumber: '771234567890',
      expectedArrivalUntil: '2026-10-09T20:00:00-05:00',
      itemShipped: [
        { '@type': 'Product', name: 'Stand Mixer', image: 'https://i5.walmartimages.com/mixer.jpg' },
        { '@type': 'Product', name: 'Whisk' },
      ],
      partOfOrder: { '@type': 'Order', orderNumber: '2000123-45678901', merchant: { '@type': 'Organization', name: 'Walmart' }, orderStatus: 'http://schema.org/OrderInTransit' },
    };
    const f = findParcel({ subject: 'Your package shipped', text: null, html: `<script type="application/ld+json">${JSON.stringify(ld)}</script><p>Hello</p>`, from: { address: 'help@walmart.com', name: 'Walmart.com' }, date: OCT_5 });
    expect(f).toMatchObject({ site: 'walmart.com', tracking: '771234567890', carrier: 'fedex', order: '2000123-45678901', status: 'in_transit', item: 'Stand Mixer', items: 2, image: 'https://i5.walmartimages.com/mixer.jpg', eta: day(2026, 10, 10) });
  });

  it('reads the expected day', () => {
    const eta = (text: string) => findParcel({ subject: 'Shipped', text: `${text}\nTracking number: ${UPS}`, html: null, from: { address: 'a@shop.example' }, date: OCT_5 })?.eta;
    expect(eta('Arriving Thursday')).toBe(day(2026, 10, 8));
    expect(eta('Estimated delivery: Oct 12')).toBe(day(2026, 10, 12));
    expect(eta('Expected delivery date: Tuesday, October 13, 2026')).toBe(day(2026, 10, 13));
    expect(eta('Arriving tomorrow by 9pm')).toBe(day(2026, 10, 6));
    expect(eta('It should arrive on 3 January')).toBe(day(2027, 1, 3)); // next year
    expect(eta('No date here')).toBeUndefined();
  });

  it('tells shipped and delivered from “when it ships” and “will be delivered”', () => {
    const status = (subject: string, text = '') => findParcel({ subject, text: `${text}\nTracking number: ${UPS}`, html: null, from: { address: 'a@shop.example' }, date: OCT_5 })?.status;
    expect(status('Delivered: "Echo Dot"')).toBe('delivered');
    expect(status('Your package has been delivered')).toBe('delivered');
    expect(status('Out for delivery: "Echo Dot"')).toBe('out_for_delivery');
    expect(status('Your order', 'Thanks for your order! It will be delivered by Friday.')).toBe('ordered');
    expect(status('Your order', 'We’ll email you when your items have shipped.')).toBeUndefined();
    expect(status('Your order has been cancelled')).toBe('cancelled');
  });

  it('leaves other mail alone', () => {
    const none = (subject: string, text: string, from = 'hello@friend.example') => findParcel({ subject, text, html: null, from: { address: from }, date: OCT_5 });
    expect(none('Your receipt', 'Order 48213 total $59.00, thanks!', 'receipts@cafe.example')).toBeNull();
    expect(none('Lunch?', 'Call me at 5551234567 tomorrow')).toBeNull();
    expect(none('Shipping it', 'Ref 1ZA0T5770319884735 (not a real UPS number)')).toBeNull(); // wrong check digit
    expect(none('Meeting notes', 'Our DHL contract number is 1234567890.')).toBeNull(); // no shipping words
  });

  it('doesn’t let a look-alike sender pass as the shop', () => {
    const f = findParcel({
      subject: 'Your Amazon package is delayed',
      text: `Tracking number: ${UPS}`,
      html: `<a href="https://amazon.com.account-verify.example/login">View order</a> <a href="https://www.amazon.com/gp/css/order-history">Your orders</a>`,
      from: { address: 'ship@account-verify.example', name: 'Amazon' },
      date: OCT_5,
    });
    expect(f?.merchant).toBe('account-verify.example');
    expect(f?.orderUrl).toBe('https://amazon.com.account-verify.example/login'); // its own site, shown as such
    expect(siteOf('amazon.com.account-verify.example')).toBe('account-verify.example');
    expect(siteOf('shipment-tracking.amazon.co.uk')).toBe('amazon.co.uk');
  });
});

describe('the order card', () => {
  it('puts every email about the package together (Gmail’s “based on 4 emails”)', async () => {
    const t0 = Date.now() - 5 * 86_400_000;
    const ordered = await receive({
      from: "Macy's <CustomerService@oes.macys.com>",
      subject: 'Thanks for your order! Order #4795458681',
      text: 'We received your order. Order number: 4795458681. We’ll let you know when it ships.',
      date: t0,
    });
    const shipped = await receive({
      from: "Macy's <CustomerService@oes.macys.com>",
      subject: `Shipped: "Warner's Women's No Pinching No Problems Lace Hipster Underwear 5609J" and 5 more items`,
      html: `<p>Order Number: 4795458681</p><a href="https://www.ups.com/track?tracknum=${UPS}">Track package</a><a href="https://www.macys.com/purchases/details?orderNumber=4795458681">View order</a>`,
      date: t0 + 86_400_000,
    });
    const forwarder = await receive({
      from: 'SendX Jamaica LTD. <updates@sendxja.com>',
      subject: 'Package Status Update',
      text: `Your package ${UPS} has been delivered to you. Thanks for shipping with SendX!`,
      date: t0 + 3 * 86_400_000,
    });
    expect(ordered.parcel).toContain('4795458681');

    const card = (await thread(forwarder.thread_id)).parcel;
    expect(card).toMatchObject({
      messageId: forwarder.id,
      status: 'delivered',
      merchant: 'Macy’s',
      order: '4795458681',
      tracking: UPS,
      carrier: 'UPS',
      item: "Warner's Women's No Pinching No Problems Lace Hipster Underwear 5609J",
      items: 6,
      orderUrl: 'https://www.macys.com/purchases/details?orderNumber=4795458681',
      trackUrl: `https://www.ups.com/track?tracknum=${UPS}`,
      emails: 3,
      eta: null,
    });
    expect(card.statusAt).toBe(forwarder.date);
    // The shop's own conversation shows the same package.
    expect((await thread(shipped.thread_id)).parcel).toMatchObject({ status: 'delivered', emails: 3 });
    // And the inbox row says where it is.
    expect((await inbox()).find((t) => t.id === forwarder.thread_id).parcel).toMatchObject({ status: 'delivered' });
  });

  it('sends View order to the shop’s own page (its app on a phone)', async () => {
    const m = await receive({
      from: 'Amazon.com <shipment-tracking@amazon.com>',
      subject: 'Arriving tomorrow: "Echo Dot (5th Gen)"',
      text: 'Your package is on the way. Order # 112-1234567-1234567. Track your package: TBA123456789012',
    });
    expect((await thread(m.thread_id)).parcel).toMatchObject({
      merchant: 'Amazon',
      status: 'in_transit',
      order: '112-1234567-1234567',
      orderUrl: 'https://www.amazon.com/gp/your-account/order-details?orderID=112-1234567-1234567',
      tracking: 'TBA123456789012',
      trackUrl: 'https://track.amazon.com/tracking/TBA123456789012',
      emails: 1,
    });
  });

  it('looks at older mail the first time it’s opened', async () => {
    const m = await receive({ from: 'Walmart <help@walmart.com>', subject: 'Your order shipped', text: 'Order# 200012345678901. It’s on its way.' });
    run('UPDATE messages SET parcel = NULL WHERE id = ?', [m.id]);
    const card = (await thread(m.thread_id)).parcel;
    expect(card).toMatchObject({ merchant: 'Walmart', orderUrl: 'https://www.walmart.com/orders/200012345678901' });
    expect(get<any>('SELECT parcel FROM messages WHERE id = ?', [m.id]).parcel).toContain('200012345678901');
  });

  it('follows a Lowe’s order from confirmation to FedEx’s delivery email', async () => {
    const t0 = Date.now() - 6 * 86_400_000;
    const confirmed = await receive({
      from: "Lowe's <LowesOrders@e.lowes.com>",
      subject: 'We’ve received your order #200345678',
      html: '<p>Thanks for your order! Order #200345678. We’ll email you when it ships.</p><a href="https://www.lowes.com/mylowes/orders/200345678">View Order Details</a>',
      date: t0,
    });
    // Before it ships, the confirmation already has its card (Lowe’s is a shop we know).
    expect((await thread(confirmed.thread_id)).parcel).toMatchObject({ status: 'ordered', merchant: 'Lowe’s', order: '200345678', emails: 1 });
    await receive({
      from: "Lowe's <LowesOrders@e.lowes.com>",
      subject: 'Your order has shipped!',
      html: '<p>Order #200345678 is on its way.</p><p>Tracking Number: <a href="https://www.fedex.com/fedextrack/?trknbr=771234567890">771234567890</a></p>',
      date: t0 + 86_400_000,
    });
    // FedEx's own email never says "FedEx" in its text, nor which order it is.
    const delivered = await receive({ from: 'FedEx <TrackingUpdates@fedex.com>', subject: 'Your package has been delivered', text: 'Tracking number 771234567890. Left at front door.', date: t0 + 3 * 86_400_000 });
    expect(JSON.parse(delivered.parcel)).toMatchObject({ carrier: 'fedex', tracking: '771234567890' });
    for (const id of [confirmed.thread_id, delivered.thread_id]) {
      expect((await thread(id)).parcel).toMatchObject({
        status: 'delivered',
        merchant: 'Lowe’s',
        order: '200345678',
        carrier: 'FedEx',
        tracking: '771234567890',
        orderUrl: 'https://www.lowes.com/mylowes/orders/200345678',
        trackUrl: 'https://www.fedex.com/fedextrack/?trknbr=771234567890',
        emails: 3,
      });
    }
  });

  it('joins a small shop’s confirmation once it ships, without mixing up shops on a shared domain', async () => {
    const t0 = Date.now() - 4 * 86_400_000;
    const shopA = 'Fern & Clay <store+111@t.shopifyemail.com>';
    const shopB = 'Kettle Co <store+222@t.shopifyemail.com>';
    const confirmA = await receive({ from: shopA, subject: 'Order #1001 confirmed', text: 'Thank you for your purchase! Order #1001. We’ll let you know when it ships. Shipping: Standard', date: t0 });
    // An order confirmation from a shop we don't know: no card yet.
    expect((await thread(confirmA.thread_id)).parcel).toBeNull();
    const confirmB = await receive({ from: shopB, subject: 'Order #1001 confirmed', text: 'Thank you for your purchase! Order #1001. Shipping: Express', date: t0 + 60_000 });
    await receive({
      from: shopA,
      subject: 'A shipment from order #1001 is on the way',
      html: `<p>Order #1001</p><a href="https://shopify.com/123/account/orders/456">View your order</a> <a href="https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223456789017">Track shipment</a>`,
      date: t0 + 86_400_000,
    });
    expect((await thread(confirmA.thread_id)).parcel).toMatchObject({
      merchant: 'Fern & Clay',
      status: 'in_transit',
      tracking: '9400111899223456789017',
      orderUrl: 'https://shopify.com/123/account/orders/456',
      emails: 2,
    });
    // The other shop's order #1001 has no card until it ships, then its own.
    expect((await thread(confirmB.thread_id)).parcel).toBeNull();
    await receive({ from: shopB, subject: 'Your order #1001 has shipped', text: 'Order #1001. UPS tracking number: 1Z999AA10123456784', date: t0 + 2 * 86_400_000 });
    expect((await thread(confirmB.thread_id)).parcel).toMatchObject({ merchant: 'Kettle Co', tracking: '1Z999AA10123456784', emails: 2 });
    expect((await thread(confirmA.thread_id)).parcel).toMatchObject({ merchant: 'Fern & Clay', tracking: '9400111899223456789017', emails: 2 });
    // A take-out receipt is not a package.
    const food = await receive({ from: 'Taco Spot <orders@tacospot.example>', subject: 'Thanks for your order', text: 'Order #4821 confirmed. Delivery in 30 minutes.' });
    expect((await thread(food.thread_id)).parcel).toBeNull();
  });

  it('shows no card for mail that isn’t about a package, or that failed DMARC', async () => {
    const plain = await receive({ from: 'Kim <kim@friend.example>', subject: 'Lunch plans', text: 'Thursday at noon?' });
    expect((await thread(plain.thread_id)).parcel).toBeNull();
    expect(get<any>('SELECT parcel FROM messages WHERE id = ?', [plain.id]).parcel).toBe('');
    const forged = await receive({ from: 'Amazon <shipment-tracking@amazon.com>', subject: 'Delivered: "Gift card"', text: `Tracking number: ${UPS}`, verdicts: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } });
    expect(forged.parcel).toBe('');
  });
});
