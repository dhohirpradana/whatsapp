// Sqlite3 database
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:');

db.serialize(function () {
    console.log("Database created");
    // create table to store request_response
    db.run("CREATE TABLE IF NOT EXISTS request_response (key TEXT, value TEXT)");
    // create table to store code
    db.run("CREATE TABLE IF NOT EXISTS code (key TEXT, value TEXT)");
});

export { db };