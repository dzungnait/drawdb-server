import { createTransport, Transporter } from 'nodemailer';
import { type Attachment } from 'nodemailer/lib/mailer';
import { config, mailEnabled } from '../config';

let transporter: Transporter | null = null;
const getTransporter = () => {
  const { host, port, secure, service, username, password } = config.mail;
  const auth = username ? { user: username, pass: password } : undefined;
  // Short timeouts: a blocked or wrong SMTP server fails within seconds
  const timeouts = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 };
  return (transporter ??= createTransport(
    host ? { host, port, secure, auth, ...timeouts } : { service, auth, ...timeouts },
  ));
};

/** Messages "sent" while running tests, newest last. */
export const testOutbox: { to: string; subject: string; html: string; text?: string }[] = [];

async function sendEmail(
  subject: string,
  message: string,
  to: string,
  from: string,
  attachments: Attachment[] = [],
  text?: string,
) {
  if (config.test) {
    testOutbox.push({ to, subject, html: message, text });
    return 'test';
  }
  const info = await getTransporter().sendMail({
    from,
    to,
    subject,
    html: message,
    text,
    attachments,
  });
  return info.messageId;
}

/**
 * Sends a transactional email if mail is configured, in the background:
 * the request that caused it doesn't wait for the mail server, and a
 * failure is only logged.
 */
function sendTransactionalEmail(
  to: string,
  subject: string,
  { html, text }: { html: string; text: string },
) {
  if (!config.test && !mailEnabled()) {
    console.warn(`Mail is not configured; not sending "${subject}" to ${to}`);
    return;
  }
  sendEmail(subject, html, to, config.mail.from, [], text).catch((e) =>
    console.error(`Sending "${subject}" to ${to} failed:`, e),
  );
}

export { sendEmail, sendTransactionalEmail };
