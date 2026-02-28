let key = 1;
export const uKey = () => key++;

export const toArray = (obj: any) => (Array.isArray(obj) ? obj : []);

const a = {
  b: 1,
} as const;

a.b;
