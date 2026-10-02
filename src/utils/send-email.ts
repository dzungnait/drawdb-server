import { createTransport, Transporter } from 'nodemailer';
import { type Attachment } from 'nodemailer/lib/mailer';
import { config, mailEnabled } from '../config';

let transporter: Transporter | null = null;
const getTransporter = () => {
  const { host, port, secure, service, username, password } = config.mail;
  const auth = username ? { user: username, pass: password } : undefined;
  return (transporter ??= createTransport(host ? { host, port, secure, auth } : { service, auth }));
};

/** Messages "sent" while running tests, newest last. */
export const testOutbox: { to: string; subject: string; html: string }[] = [];

async function sendEmail(
  subject: string,
  message: string,
  to: string,
  from: string,
  attachments: Attachment[] = [],
) {
  if (config.test) {
    testOutbox.push({ to, subject, html: message });
    return 'test';
  }
  const info = await getTransporter().sendMail({ from, to, subject, html: message, attachments });
  return info.messageId;
}

/** Sends a transactional email if mail is configured; never throws. */
async function sendTransactionalEmail(to: string, subject: string, html: string) {
  if (!config.test && !mailEnabled()) {
    console.warn(`Mail is not configured; not sending "${subject}" to ${to}`);
    return false;
  }
  try {
    await sendEmail(subject, html, to, config.mail.from);
    return true;
  } catch (e) {
    console.error('Email sending failed:', e);
    return false;
  }
}

export { sendEmail, sendTransactionalEmail };
