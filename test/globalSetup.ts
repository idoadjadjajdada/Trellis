import pg from 'pg';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';

export default async function setup() {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  await client.query('DROP DATABASE IF EXISTS trellis_test WITH (FORCE)');
  await client.query('CREATE DATABASE trellis_test');
  await client.end();
}
