import { stopMongoServer } from './mongoServerSingleton.js';

export default async function globalTeardown() {
  await stopMongoServer();
}
