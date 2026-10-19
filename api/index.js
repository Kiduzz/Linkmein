// Vercel serves every /api/* and /auth/* request through this one function.
// It runs the compiled server from `npm run build`.
export { default } from "../dist/server/vercel.js";
