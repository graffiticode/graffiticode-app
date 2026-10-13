# Generate Invite Codes Script

This script generates random 6-digit integers that can be used as invite codes.

## Usage

```bash
# Generate 10 codes (default)
node scripts/generate-invite-codes.js

# Generate a specific number of codes
node scripts/generate-invite-codes.js 20

# Generate codes in different formats
node scripts/generate-invite-codes.js 5 env    # Environment variable format
node scripts/generate-invite-codes.js 5 array  # JavaScript array format
node scripts/generate-invite-codes.js 5 lines  # One code per line
```

## Output Formats

### Default Format
```
Generated 5 invite codes:

234567, 891234, 567890, 123456, 789012
```

### Environment Variable Format (`env`)
```
Generated 5 invite codes:

For environment variable:
VALID_INVITE_CODES=234567,891234,567890,123456,789012
```

### JavaScript Array Format (`array`)
```
Generated 5 invite codes:

As JavaScript array:
[
  "234567",
  "891234",
  "567890",
  "123456",
  "789012"
]
```

### One Per Line Format (`lines`)
```
Generated 5 invite codes:

234567
891234
567890
123456
789012
```

## Examples

1. Generate codes for production deployment:
   ```bash
   node scripts/generate-invite-codes.js 20 env
   ```

2. Generate codes for testing:
   ```bash
   node scripts/generate-invite-codes.js 5 array
   ```

3. Generate codes for distribution:
   ```bash
   node scripts/generate-invite-codes.js 100 lines > invite-codes.txt
   ```

## Security Notes

- All generated codes are cryptographically random 6-digit integers
- Codes are guaranteed to be unique within each generation batch
- Consider the lifespan and rotation schedule for invite codes
- Store generated codes securely if using for production