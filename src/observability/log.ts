export const logEvent = (name: string, fields: Record<string, unknown>): void => {
  const at = typeof fields["at"] === "number" ? fields["at"] : Date.now();
  console.log(JSON.stringify({ event: name, timestamp: new Date(at).toISOString(), ...fields }));
};
