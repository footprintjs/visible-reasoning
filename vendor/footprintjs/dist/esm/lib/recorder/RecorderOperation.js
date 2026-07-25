/**
 * RecorderOperation — the three standard operations on auto-collected traversal data.
 *
 * Data is collected during the single DFS traversal. The consumer chooses the
 * operation at READ time:
 *
 * | Operation   | KeyedStore method        | SequenceStore method           | Use case                    |
 * |-------------|--------------------------|--------------------------------|-----------------------------|
 * | Translate   | `get(id)`                | `getByKey(id)`                 | Per-step detail             |
 * | Accumulate  | `accumulate(fn, init, k)` | `accumulate(fn, init, k)`     | Running total up to slider  |
 * | Aggregate   | `aggregate(fn, init)`    | `aggregate(fn, init)`          | Grand total for dashboards  |
 *
 * Recorders declare a `preferredOperation` to hint the UI about which operation
 * to show prominently. The consumer can override via constructor options.
 *
 * @example
 * ```typescript
 * import { MetricRecorder, RecorderOperation } from 'footprintjs';
 *
 * // Use named constant (autocomplete)
 * new MetricRecorder({ preferredOperation: RecorderOperation.Aggregate });
 *
 * // Or inline string (same type)
 * new MetricRecorder({ preferredOperation: 'accumulate' });
 * ```
 */
export const RecorderOperation = {
    /** Per-step detail — what happened at this execution step? */
    Translate: 'translate',
    /** Progressive running total — value grows as the slider scrubs forward. */
    Accumulate: 'accumulate',
    /** Grand total across all steps — dashboard / export summary. */
    Aggregate: 'aggregate',
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUmVjb3JkZXJPcGVyYXRpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3JlY29yZGVyL1JlY29yZGVyT3BlcmF0aW9uLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBeUJHO0FBQ0gsTUFBTSxDQUFDLE1BQU0saUJBQWlCLEdBQUc7SUFDL0IsOERBQThEO0lBQzlELFNBQVMsRUFBRSxXQUFXO0lBQ3RCLDRFQUE0RTtJQUM1RSxVQUFVLEVBQUUsWUFBWTtJQUN4QixpRUFBaUU7SUFDakUsU0FBUyxFQUFFLFdBQVc7Q0FDZCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWNvcmRlck9wZXJhdGlvbiDigJQgdGhlIHRocmVlIHN0YW5kYXJkIG9wZXJhdGlvbnMgb24gYXV0by1jb2xsZWN0ZWQgdHJhdmVyc2FsIGRhdGEuXG4gKlxuICogRGF0YSBpcyBjb2xsZWN0ZWQgZHVyaW5nIHRoZSBzaW5nbGUgREZTIHRyYXZlcnNhbC4gVGhlIGNvbnN1bWVyIGNob29zZXMgdGhlXG4gKiBvcGVyYXRpb24gYXQgUkVBRCB0aW1lOlxuICpcbiAqIHwgT3BlcmF0aW9uICAgfCBLZXllZFN0b3JlIG1ldGhvZCAgICAgICAgfCBTZXF1ZW5jZVN0b3JlIG1ldGhvZCAgICAgICAgICAgfCBVc2UgY2FzZSAgICAgICAgICAgICAgICAgICAgfFxuICogfC0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS18LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS18XG4gKiB8IFRyYW5zbGF0ZSAgIHwgYGdldChpZClgICAgICAgICAgICAgICAgIHwgYGdldEJ5S2V5KGlkKWAgICAgICAgICAgICAgICAgIHwgUGVyLXN0ZXAgZGV0YWlsICAgICAgICAgICAgIHxcbiAqIHwgQWNjdW11bGF0ZSAgfCBgYWNjdW11bGF0ZShmbiwgaW5pdCwgaylgIHwgYGFjY3VtdWxhdGUoZm4sIGluaXQsIGspYCAgICAgfCBSdW5uaW5nIHRvdGFsIHVwIHRvIHNsaWRlciAgfFxuICogfCBBZ2dyZWdhdGUgICB8IGBhZ2dyZWdhdGUoZm4sIGluaXQpYCAgICB8IGBhZ2dyZWdhdGUoZm4sIGluaXQpYCAgICAgICAgICB8IEdyYW5kIHRvdGFsIGZvciBkYXNoYm9hcmRzICB8XG4gKlxuICogUmVjb3JkZXJzIGRlY2xhcmUgYSBgcHJlZmVycmVkT3BlcmF0aW9uYCB0byBoaW50IHRoZSBVSSBhYm91dCB3aGljaCBvcGVyYXRpb25cbiAqIHRvIHNob3cgcHJvbWluZW50bHkuIFRoZSBjb25zdW1lciBjYW4gb3ZlcnJpZGUgdmlhIGNvbnN0cnVjdG9yIG9wdGlvbnMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IE1ldHJpY1JlY29yZGVyLCBSZWNvcmRlck9wZXJhdGlvbiB9IGZyb20gJ2Zvb3RwcmludGpzJztcbiAqXG4gKiAvLyBVc2UgbmFtZWQgY29uc3RhbnQgKGF1dG9jb21wbGV0ZSlcbiAqIG5ldyBNZXRyaWNSZWNvcmRlcih7IHByZWZlcnJlZE9wZXJhdGlvbjogUmVjb3JkZXJPcGVyYXRpb24uQWdncmVnYXRlIH0pO1xuICpcbiAqIC8vIE9yIGlubGluZSBzdHJpbmcgKHNhbWUgdHlwZSlcbiAqIG5ldyBNZXRyaWNSZWNvcmRlcih7IHByZWZlcnJlZE9wZXJhdGlvbjogJ2FjY3VtdWxhdGUnIH0pO1xuICogYGBgXG4gKi9cbmV4cG9ydCBjb25zdCBSZWNvcmRlck9wZXJhdGlvbiA9IHtcbiAgLyoqIFBlci1zdGVwIGRldGFpbCDigJQgd2hhdCBoYXBwZW5lZCBhdCB0aGlzIGV4ZWN1dGlvbiBzdGVwPyAqL1xuICBUcmFuc2xhdGU6ICd0cmFuc2xhdGUnLFxuICAvKiogUHJvZ3Jlc3NpdmUgcnVubmluZyB0b3RhbCDigJQgdmFsdWUgZ3Jvd3MgYXMgdGhlIHNsaWRlciBzY3J1YnMgZm9yd2FyZC4gKi9cbiAgQWNjdW11bGF0ZTogJ2FjY3VtdWxhdGUnLFxuICAvKiogR3JhbmQgdG90YWwgYWNyb3NzIGFsbCBzdGVwcyDigJQgZGFzaGJvYXJkIC8gZXhwb3J0IHN1bW1hcnkuICovXG4gIEFnZ3JlZ2F0ZTogJ2FnZ3JlZ2F0ZScsXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBSZWNvcmRlck9wZXJhdGlvbiA9ICh0eXBlb2YgUmVjb3JkZXJPcGVyYXRpb24pW2tleW9mIHR5cGVvZiBSZWNvcmRlck9wZXJhdGlvbl07XG4iXX0=