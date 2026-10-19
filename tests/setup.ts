import os from "node:os";
import path from "node:path";

// Each test worker gets its own storage folder so parallel files don't collide.
process.env.DATA_DIR = path.join(os.tmpdir(), `linkmein-test-${process.pid}`);
