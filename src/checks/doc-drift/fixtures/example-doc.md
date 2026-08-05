# retry-cli

Wrap any command with retries:

```sh
retry-cli --attempts 3 --jitter full -- curl https://example.com
```

`--attempts` sets how many retries run (default 5); `--base-delay` sets the
initial delay in milliseconds (default 100).
