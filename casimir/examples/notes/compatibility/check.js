import assert from 'node:assert/strict';
/** Author-owned bounded CRUD cases against the retained release's old schema. */
export async function verifyCompatibility({ db, recordId }) {
  const inserted = db
    .prepare('INSERT INTO messages(text) VALUES (?) RETURNING id,text')
    .get(recordId);
  assert.equal(inserted.text, recordId);
  try {
    db.prepare('UPDATE messages SET text=? WHERE id=?').run(recordId + '-updated', inserted.id);
    assert.equal(
      db.prepare('SELECT text FROM messages WHERE id=?').get(inserted.id).text,
      recordId + '-updated',
    );
  } finally {
    db.prepare('DELETE FROM messages WHERE id=?').run(inserted.id);
  }
  assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get(inserted.id), undefined);
}
