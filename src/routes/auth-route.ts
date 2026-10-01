import express from 'express';
import * as c from '../controllers/auth-controller';
import { asyncHandler, requireSignedIn, requireUser } from '../auth/middleware';
import { authLimiter } from '../middleware/rate-limit';

const authRouter = express.Router();
const h = asyncHandler;

authRouter.get('/providers', h(c.providers));

authRouter.post('/register', authLimiter, h(c.register));
authRouter.post('/login', authLimiter, h(c.login));
authRouter.post('/logout', h(c.logout));

authRouter.post('/password/forgot', authLimiter, h(c.forgotPassword));
authRouter.post('/password/reset', authLimiter, h(c.resetPassword));
authRouter.post('/email/verify', authLimiter, h(c.verifyEmail));

authRouter.get('/oauth/:provider', authLimiter, h(c.oauthStart));
authRouter.get('/oauth/:provider/callback', h(c.oauthCallback));

// Signed in, verified or not: these are how an unverified user gets verified
authRouter.get('/me', requireSignedIn, h(c.me));
authRouter.post('/email/resend', requireSignedIn, authLimiter, h(c.resendVerification));

authRouter.patch('/me', requireUser, h(c.updateProfile));
authRouter.delete('/me', requireSignedIn, authLimiter, h(c.deleteAccount));
authRouter.post('/password', requireUser, authLimiter, h(c.changePassword));
authRouter.post('/sessions/revoke-others', requireUser, h(c.logoutOthers));

export { authRouter };
