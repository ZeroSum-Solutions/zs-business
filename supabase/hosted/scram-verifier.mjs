// Owner-run helper for bootstrap-roles.sql: turn the password in the environment variable
// named by argv[2] into a PostgreSQL SCRAM-SHA-256 verifier, so the plaintext never reaches
// the server, where log_statement=ddl would log CREATE/ALTER ROLE ... PASSWORD.
//   ZS_MIGRATOR_VERIFIER=$(node supabase/hosted/scram-verifier.mjs ZS_MIGRATOR_PASSWORD)
// The password must be 32+ printable ASCII characters (no SASLprep needed). Refuses a terminal.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import process from "node:process";

const name = process.argv[2] ?? "";
const password = process.env[name] ?? "";
if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error("Pass the name of the environment variable that holds the password");
if (password.length < 32 || !/^[\x21-\x7e]+$/.test(password)) throw new Error(`${name} must be 32+ printable ASCII characters`);
if (process.stdout.isTTY) throw new Error("Refusing to print a verifier to a terminal");

const iterations = 4096;
const salt = randomBytes(16);
const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const hmac = (key, text) => createHmac("sha256", key).update(text).digest();
const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest();
const serverKey = hmac(salted, "Server Key");
const b64 = (bytes) => bytes.toString("base64");
process.stdout.write(`SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`);
