# Invite Code Configuration

The application supports invite codes to control user access. These can be configured via environment variables for deployment flexibility.

## Environment Variable

Set the `VALID_INVITE_CODES` environment variable to override the default invite codes:

```bash
VALID_INVITE_CODES=CODE1,CODE2,CODE3
```

The codes should be comma-separated. Whitespace around codes is automatically trimmed.

## Default Codes

If no environment variable is set, the following default codes are available:
- `WELCOME2025`
- `EARLY_ACCESS`
- `BETA_USER`

## Deployment Examples

### Vercel
Add to your Vercel project settings:
```
VALID_INVITE_CODES=PRODUCTION2025,SPECIAL_ACCESS
```

### Local Development
Create a `.env.local` file:
```
VALID_INVITE_CODES=DEV_CODE,TEST_CODE
```

### Docker
Pass as an environment variable:
```bash
docker run -e VALID_INVITE_CODES=DOCKER_CODE,CONTAINER_CODE ...
```

## Security Considerations

- Invite codes should be treated as temporary access controls
- Consider rotating codes periodically
- Monitor usage to detect any unauthorized access attempts
- Codes are case-insensitive (e.g., "welcome2025", "WELCOME2025", and "Welcome2025" are all valid)