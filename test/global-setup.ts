import { Client } from 'pg';

// Fresh schema for every run; migrations are applied by the tests' app import
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://drawdb:drawdb@localhost:55432/drawdb_test';
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
}
