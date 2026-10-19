// Vercel entry point: the Express app as a single function. Scheduled posts are
// published by /api/cron/publish, which a cron service calls every minute.
import { createApp } from "./app.js";

export default createApp();
