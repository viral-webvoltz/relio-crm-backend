// Escapes LIKE wildcards so a search for "50%" or "a_b" matches literally instead of everything.
export const likeContains = (search: string) => '%' + search.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
