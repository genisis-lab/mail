import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv, toCsv } from '../src/web/lib/csv';
import { contactsFromCsv, contactsFromFile, contactsFromVcard } from '../src/web/lib/contacts-import';

describe('CSV', () => {
  it('handles quotes, doubled quotes, CRLF, a BOM and semicolons', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(parseCsv('name;email\nAnn;ann@example.org\n')).toEqual([
      ['name', 'email'],
      ['Ann', 'ann@example.org'],
    ]);
    expect(parseCsv('a,b\n"multi\nline",2')).toEqual([
      ['a', 'b'],
      ['multi\nline', '2'],
    ]);
    expect(csvRecords('Full Name,E-mail Address\nAnn,ann@example.org').records).toEqual([{ fullname: 'Ann', emailaddress: 'ann@example.org' }]);
    expect(parseCsv(toCsv([['a,b', 'c"d', null], [1, 'x\ny', '']]))).toEqual([
      ['a,b', 'c"d', ''],
      ['1', 'x\ny', ''],
    ]);
  });
});

describe('contact files', () => {
  it('reads Google Contacts CSV, including several addresses in one cell', () => {
    const google = 'First Name,Middle Name,Last Name,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Value,Organization Name,Notes\nZoë,,Quinn,* Home,zoe@example.org ::: zq@work.example,+1 555 0100,Quartz,"likes ""tea"""\n,,,,not-an-email,,,\n';
    expect(contactsFromCsv(google)).toEqual([
      { email: 'zoe@example.org', name: 'Zoë Quinn', phone: '+1 555 0100', company: 'Quartz', notes: 'likes "tea"' },
      { email: 'zq@work.example', name: 'Zoë Quinn', phone: '+1 555 0100', company: 'Quartz', notes: 'likes "tea"' },
    ]);
  });

  it('reads Outlook CSV and Wren’s own export', () => {
    expect(contactsFromCsv('First Name,Last Name,E-mail Address,Mobile Phone,Company\nMax,Power,max@example.org,555,Acme\n')).toEqual([
      { email: 'max@example.org', name: 'Max Power', phone: '555', company: 'Acme', notes: '' },
    ]);
    expect(contactsFromCsv('name,email,phone,company,notes\nPat,pat@example.org,,,\n')[0]).toMatchObject({ email: 'pat@example.org', name: 'Pat' });
  });

  it('reads vCards with folded lines, escapes and several emails', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Moreau;Alice;;;',
      'item1.EMAIL;TYPE=INTERNET:alice@example.org',
      'EMAIL;TYPE=WORK:alice@work.example',
      'TEL;TYPE=CELL:+33 6 00 00 00 00',
      'ORG:Fernhill\\, Inc.;Mail team',
      'NOTE:first line\\nsecond lin',
      ' e continued',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:No Email',
      'END:VCARD',
    ].join('\r\n');
    expect(contactsFromVcard(vcf)).toEqual([
      { email: 'alice@example.org', name: 'Alice Moreau', phone: '+33 6 00 00 00 00', company: 'Fernhill, Inc.', notes: 'first line\nsecond line continued' },
      { email: 'alice@work.example', name: 'Alice Moreau', phone: '+33 6 00 00 00 00', company: 'Fernhill, Inc.', notes: 'first line\nsecond line continued' },
    ]);
    expect(contactsFromFile('people.txt', 'BEGIN:VCARD\nFN:A\nEMAIL:a@example.org\nEND:VCARD')).toHaveLength(1);
  });
});
