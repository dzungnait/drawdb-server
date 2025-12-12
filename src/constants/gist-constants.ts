import { config } from '../config';

export const gistsBaseUrl = 'https://api.github.com/gists';

export const headers = {
  'X-GitHub-Api-Version': '2022-11-28',
  // GitHub token no longer needed - using PostgreSQL instead
  // Authorization: 'Bearer ' + config.api.github,
};
