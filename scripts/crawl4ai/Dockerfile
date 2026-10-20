# Dedicated context only. Never copy Marketingbus code, .env files or credentials.
FROM unclecode/crawl4ai@sha256:636a6f9e5127f54771f14f709bf1b95693aacc30512426b26d09768b0269f1f4
COPY config.yml /app/config.yml
COPY start.sh /app/marketingbus-start.sh
COPY html_worker.py html_server.py /app/
ENV CRAWL4AI_CHROMIUM_SANDBOX=true \
    CRAWL4AI_ALLOW_INTERNAL_URLS=false \
    CRAWL4AI_ALLOW_INSECURE_TLS=false \
    CRAWL4AI_HOOKS_ENABLED=false \
    CRAWL4AI_EXECUTE_JS_ENABLED=false \
    CRAWL4AI_ALLOW_DEEP_CRAWL=false \
    REDIS_TASK_TTL=60
USER appuser
EXPOSE 11235
CMD ["python", "-I", "/app/html_server.py"]
