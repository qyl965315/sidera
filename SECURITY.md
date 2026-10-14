# Security

- Secrets are never committed. Keep configuration and tokens outside the repository; local runtime data lives under .sidera-dev which is ignored.
- Effects require scoped Authority and, where configured, an exact Human confirmation. Uncertain effects are never replayed automatically.
- Report vulnerabilities by opening a private security advisory on this repository. Do not include live credentials in reports.
