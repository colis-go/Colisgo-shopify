import mongoose from "mongoose";

declare global {
  // eslint-disable-next-line no-var
  var mongooseConnectionGlobal: Promise<typeof mongoose> | undefined;
}

const MONGODB_URL = process.env.MONGODB_URL;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "colisgo_shopify";

if (!MONGODB_URL) {
  throw new Error("MONGODB_URL is not set");
}

function connect() {
  return mongoose.connect(MONGODB_URL as string, {
    dbName: MONGODB_DB_NAME,
  });
}

// Reuse the connection across HMR reloads in dev and across lambda-style
// cold starts, the same pattern the core ColisGo backend uses for Mongoose.
const connectionPromise = global.mongooseConnectionGlobal ?? connect();

if (process.env.NODE_ENV !== "production") {
  global.mongooseConnectionGlobal = connectionPromise;
}

export default connectionPromise;
