// Entry point. On its own the Worker serves only the RedditPZ features; when merged into
// sourdoughrides.com this route mount moves into Sean's app (src/app.tsx) behind its flag.
import { Hono } from 'hono';
import { rpzApi, type RpzEnv } from './rpz/api';

const app = new Hono<{ Bindings: RpzEnv }>();
app.route('/rpz/api', rpzApi());
app.get('/healthz', (c) => c.text('ok'));

export default app;
