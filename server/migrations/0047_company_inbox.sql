-- A main (company-less) bot that accepts `/supermux-message` from company bots
-- (`POST /api/hook/delegate`). Opt-in PER BOT: no row = closed, which stays the
-- default — a company bot reaches only its own company. `companies` is `*`
-- (every company) or a JSON array of company ids. Set by the owner only, via
-- `PUT /api/sessions/{name}/company-inbox`.
CREATE TABLE company_inbox (
    session    TEXT PRIMARY KEY REFERENCES sessions(name) ON DELETE CASCADE ON UPDATE CASCADE,
    companies  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
