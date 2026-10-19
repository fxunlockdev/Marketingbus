process.once("message", input => {
  if (input.url === "hang") { setInterval(() => {}, 1000); return; }
  const result = { success: true, data: { markdown: "This is the real child fixture response, not generated brand evidence.",
    metadata: { url: input.url, sourceURL: input.url, statusCode: 200 } }, environment: Object.keys(process.env) };
  if (input.url === "oversized") result.data.markdown = "x".repeat(500001);
  process.send(result, () => {
    if (input.url === "duplicate") process.send(result, () => process.exit(0));
    else process.exit(input.url === "failed" ? 1 : 0);
  });
});
