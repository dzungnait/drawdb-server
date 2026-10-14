import { config } from '../config';

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export interface EmailContent {
  /** Shown by mail apps next to the subject; plain text. */
  preview: string;
  heading: string;
  /** Paragraphs, already escaped HTML (use escapeHtml on anything user-given). */
  paragraphs: string[];
  /** Label/value rows shown in a box, e.g. the diagram and the role; plain text. */
  details?: [string, string][];
  action: { label: string; url: string };
  /** A small note under the button, e.g. when the link expires; plain text. */
  note?: string;
  /** Why the person got this email, in the footer; plain text. */
  reason: string;
}

const BRAND = '#175e7a';
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

/**
 * A transactional email as HTML and plain text. Tables and inline styles,
 * so it looks the same in Gmail, Outlook and phone mail apps.
 */
export function renderEmail(c: EmailContent) {
  const appUrl = config.server.appUrl.replace(/\/+$/, '');
  const host = appUrl.replace(/^https?:\/\//, '');
  const url = escapeHtml(c.action.url);

  const details = c.details?.length
    ? `<tr><td style="padding:4px 0 24px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fa;border:1px solid #e3e9ee;border-radius:8px">
          ${c.details
            .map(
              ([label, value], i) => `<tr>
            <td style="padding:${i ? '0' : '14px'} 16px 14px;font:13px/1.4 ${FONT};color:#6b7a86;width:120px;vertical-align:top">${escapeHtml(label)}</td>
            <td style="padding:${i ? '0' : '14px'} 16px 14px 0;font:600 14px/1.4 ${FONT};color:#1f2a33;vertical-align:top">${escapeHtml(value)}</td>
          </tr>`,
            )
            .join('')}
        </table>
      </td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f5">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(c.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f5">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
      <tr><td style="padding:0 4px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:28px;height:28px;background:${BRAND};border-radius:7px;text-align:center;font:700 15px/28px ${FONT};color:#ffffff">d</td>
          <td style="padding-left:10px;font:700 18px/28px ${FONT};color:#1f2a33">drawDB</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${BRAND};padding:32px 32px 28px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding-bottom:16px;font:700 22px/1.3 ${FONT};color:#1f2a33">${escapeHtml(c.heading)}</td></tr>
          ${c.paragraphs
            .map(
              (p) =>
                `<tr><td style="padding-bottom:16px;font:15px/1.6 ${FONT};color:#3b4954">${p}</td></tr>`,
            )
            .join('')}
          ${details}
          <tr><td style="padding:4px 0 8px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background:${BRAND};border-radius:8px">
                <a href="${url}" style="display:inline-block;padding:12px 24px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none">${escapeHtml(c.action.label)}</a>
              </td>
            </tr></table>
          </td></tr>
          ${c.note ? `<tr><td style="padding-top:8px;font:13px/1.5 ${FONT};color:#6b7a86">${escapeHtml(c.note)}</td></tr>` : ''}
          <tr><td style="height:24px;line-height:24px;font-size:0">&nbsp;</td></tr>
          <tr><td style="padding-top:20px;border-top:1px solid #e3e9ee;font:12px/1.6 ${FONT};color:#6b7a86">
            If the button doesn't work, copy this link into your browser:<br>
            <a href="${url}" style="color:${BRAND};word-break:break-all">${url}</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:20px 8px 0;font:12px/1.6 ${FONT};color:#8796a1;text-align:center">
        ${escapeHtml(c.reason)}<br>
        drawDB &middot; <a href="${escapeHtml(appUrl)}" style="color:#8796a1">${escapeHtml(host)}</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    c.heading,
    '',
    ...c.paragraphs.map((p) => htmlToText(p) + '\n'),
    ...(c.details?.length ? [...c.details.map(([l, v]) => `${l}: ${v}`), ''] : []),
    `${c.action.label}: ${c.action.url}`,
    ...(c.note ? ['', c.note] : []),
    '',
    '--',
    c.reason,
    `drawDB - ${appUrl}`,
  ].join('\n');

  return { html, text };
}

const htmlToText = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string]!,
    )
    .trim();
