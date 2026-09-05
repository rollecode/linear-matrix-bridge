# Changelog

All notable changes to this project are documented here.

## 1.2.0 - 5.9.2026

- Condense a thread into an English search phrase
- Say so when a thread has no searchable topic

## 1.1.2 - 5.9.2026

- Log why a suggestion found nothing

## 1.1.1 - 5.9.2026

- Carry thread history across on every link path
- Search on the thread, not on the sentence asking

## 1.1.0 - 5.9.2026

- Link by mentioning the bot in plain language
- Pick the issue with Linear semantic search
- Relink and unlink to correct a wrong guess

## 1.0.0 - 5.9.2026

- Running in production
- Ignore .env, credentials and the crypto store
- Ship the Matrix icon, drop deployment-specific values from the repo

## 0.7.0 - 5.9.2026

- Copy existing thread history onto the issue on link
- Add the Matrix thread under Linear Resources

## 0.6.0 - 5.9.2026

- Many Matrix threads can link to one issue
- Linear comments fan out to every linked thread

## 0.5.1 - 5.9.2026

- Log commands, links and bridged comments

## 0.5.0 - 30.8.2026

- Read and write end-to-end encrypted rooms on the server deployment
- Matrix arrives over sync as a real user, not over appservice transactions

## 0.4.0 - 30.8.2026

- Warn on joining an encrypted room instead of ignoring it silently

## 0.3.0 - 30.8.2026

- Matrix thread maps to one Linear comment thread, not separate comments

## 0.2.1 - 30.8.2026

- One failing event no longer wedges the appservice queue

## 0.2.0 - 30.8.2026

- Node server deployment with SQLite, alongside the Worker
- systemd unit and nginx vhost in `deploy/`
- Migrations apply at startup

## 0.1.0 - 30.8.2026

- Two-way bridge between Linear issues and Matrix threads
- `!linear`, `!linear` as a reply, and `!linear link` commands
- Linear comments and state changes posted into the mapped thread
- Loop prevention through D1 dedupe tables and transaction claims
- Linear webhook signature and `hs_token` verification
- Synapse registration example and setup docs
