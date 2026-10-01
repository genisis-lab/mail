// Replaces nodemailer in the Workers bundle: raw SMTP needs Node.js sockets.
const unavailable = () => {
  throw new Error('SMTP relay is not available on Cloudflare Workers. Use an API provider such as Cloudflare Email Service or Resend.');
};
export default { createTransport: unavailable };
export const createTransport = unavailable;
