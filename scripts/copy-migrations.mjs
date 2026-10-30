// tsc does not copy .sql files; the server reads migrations from next to db.js.
import { cpSync } from 'node:fs';
cpSync('src/server/migrations', 'dist/server/migrations', { recursive: true });
