import { startMongoServer } from './mongoServerSingleton.js';

export default async function globalSetup() {
  const uri = await startMongoServer();
  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = uri;
}
