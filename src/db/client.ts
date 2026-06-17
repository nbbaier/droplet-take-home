/**
 * libsql client singleton. The whole app shares one connection to the local
 * SQLite file. NOTE: libsql's API is async — every query is awaited.
 */

import { type Client, createClient } from "@libsql/client";
import { config } from "../config";

export const db: Client = createClient({ url: config.databaseUrl });
