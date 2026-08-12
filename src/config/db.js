import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

let connectionPromise = null;

export function connectDB() {
  if (connectionPromise) return connectionPromise;

  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected');
  });

  connectionPromise = mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: 20,
  });

  return connectionPromise;
}

export async function disconnectDB() {
  await mongoose.disconnect();
  connectionPromise = null;
}

export { mongoose };
