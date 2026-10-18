/** Public build labels only. Do not serialize process.env into the bundle. */
export function buildMetadata(env = process.env) {
  const commit = env.WEAVE_SOURCE_COMMIT ?? '';
  const channel = env.WEAVE_DEPLOYMENT_CHANNEL ?? 'development';
  if (commit !== '' && !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('WEAVE_SOURCE_COMMIT must be a full lowercase Git commit SHA.');
  }
  if (!['production', 'preview', 'development'].includes(channel)) {
    throw new Error('WEAVE_DEPLOYMENT_CHANNEL is invalid.');
  }
  if (channel === 'production' && commit === '') {
    throw new Error('Production builds require WEAVE_SOURCE_COMMIT.');
  }
  return { commit, channel };
}
