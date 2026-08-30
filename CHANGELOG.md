# Changelog

All notable changes to this project are documented here.

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
