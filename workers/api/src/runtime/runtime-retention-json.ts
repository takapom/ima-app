import type { JSONValue } from 'ai';

/**
 * JSON validation for retention boundaries. It only reads data descriptors so a provider object
 * cannot execute a getter while it is being checked or copied into a model-facing value.
 */
export function isRuntimeJsonValue(value: unknown): value is JSONValue {
  try {
    return isRuntimeJsonValueInternal(value, new Set<object>());
  } catch {
    return false;
  }
}

function isRuntimeJsonValueInternal(value: unknown, stack: Set<object>): value is JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || stack.has(value)) return false;

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return false;
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) return false;
        if (!isRuntimeJsonValueInternal(descriptor.value, stack)) return false;
      }
      return Reflect.ownKeys(value).every((key) => {
        if (key === 'length') return true;
        if (typeof key !== 'string') return false;
        const index = Number(key);
        return (
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index < lengthDescriptor.value &&
          String(index) === key
        );
      });
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        'value' in descriptor &&
        descriptor.enumerable &&
        isRuntimeJsonValueInternal(descriptor.value, stack)
      );
    });
  } finally {
    stack.delete(value);
  }
}

export class RuntimeRetentionJsonError extends Error {
  constructor() {
    super('runtime retention value is not plain JSON');
    this.name = 'RuntimeRetentionJsonError';
  }
}

/** Copies validated JSON without invoking accessors or retaining provider object identity. */
export function cloneRuntimeJsonValue(value: unknown, stack = new Set<object>()): JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new RuntimeRetentionJsonError();
  }
  if (typeof value !== 'object' || stack.has(value)) throw new RuntimeRetentionJsonError();

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new RuntimeRetentionJsonError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new RuntimeRetentionJsonError();
      }
      const result: JSONValue[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !hasDataValue(descriptor)) {
          throw new RuntimeRetentionJsonError();
        }
        result.push(cloneRuntimeJsonValue(descriptor.value, stack));
      }
      return result;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) throw new RuntimeRetentionJsonError();
    const result: { [key: string]: JSONValue } = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new RuntimeRetentionJsonError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !hasDataValue(descriptor) || !descriptor.enumerable) {
        throw new RuntimeRetentionJsonError();
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneRuntimeJsonValue(descriptor.value, stack),
        writable: true,
      });
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function hasDataValue(descriptor: PropertyDescriptor): descriptor is {
  configurable?: boolean;
  enumerable?: boolean;
  value: unknown;
  writable?: boolean;
} {
  return 'value' in descriptor;
}
