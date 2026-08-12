import { MongoMemoryServer } from 'mongodb-memory-server';

// Module-level singleton - globalSetup and globalTeardown are both required
// into the same long-lived Jest CLI process (unlike test files, which run in
// worker processes), so this survives between the two.
let instance = null;

export async function startMongoServer() {
  instance = await MongoMemoryServer.create();
  return instance.getUri();
}

export async function stopMongoServer() {
  if (instance) {
    await instance.stop();
    instance = null;
  }
}
