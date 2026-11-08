/** "1 booking calendar", "2 booking calendars". */
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
