# Changelog

All notable changes to this project are documented here.

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
