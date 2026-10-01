import { AsyncLocalStorage } from 'async_hooks';
import { RequestHandler } from 'express';

const shareLink = new AsyncLocalStorage<string | null>();

/** Makes the request's share link token (X-Share-Link) visible to services. */
export const withShareLink: RequestHandler = (req, _res, next) => {
  const token = req.get('x-share-link');
  shareLink.run(token && token.length <= 100 ? token : null, next);
};

/** The share link the current request was made with, if any. */
export const currentShareLink = () => shareLink.getStore() ?? null;
