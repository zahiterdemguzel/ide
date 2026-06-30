# Test resources

Example files for manually exercising the in-app viewers.

| File | Opens in | Notes |
|------|----------|-------|
| `sample.sqlite` | Database viewer | `authors`, `books` (rowid tables), `settings` (WITHOUT ROWID → PK identity), and a read-only `uk_authors` view. |
| `library.db` | Database viewer | Same database, `.db` extension — exercises the header sniff. |
| `authors.csv` | Spreadsheet viewer | Plain tabular sample. |

Open one from the file tree to preview/edit it. The SQLite files support inline
cell editing, add/delete row, a SQL console, and Save.
