import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('D:/Sidera-R1-v0.1.0/.sidera-dev/sol/data/sidera.sqlite');
for (const q of [
  "SELECT * FROM frontend_presence_observations ORDER BY rowid DESC LIMIT 20",
  "SELECT * FROM presence_accounts ORDER BY rowid DESC LIMIT 20",
  "SELECT * FROM chief_conversations ORDER BY rowid DESC LIMIT 10"
]) {
  try { console.log("Q",q); console.log(JSON.stringify(db.prepare(q).all(),null,2)); } catch(e) { console.log("ERR",e.message); }
}
db.close();