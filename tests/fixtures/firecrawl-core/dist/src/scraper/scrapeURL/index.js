exports.scrapeURL = async (_id, url, _options, internal) => {
  if (internal.forceEngine !== "playwright" || process.env.MARKETINGBUS_PRIVATE_INTAKE !== "true") throw Error("Unsafe engine policy");
  return { success: true, document: { markdown: "The actual child wrapper enforced the bounded, certificate-verified browser profile.",
    metadata: { url, statusCode: 200, title: "Private fixture", secret: "must not leave child" } } };
};
