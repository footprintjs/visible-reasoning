/**
 * contract/openapi.ts — OpenAPI 3.1 spec generator.
 *
 * Generates an OpenAPI spec from a FlowChartContract by combining:
 * - chart.description → operation description (built incrementally during FlowChartBuilder.build())
 * - inputSchema → requestBody
 * - outputSchema → response
 *
 * chart.description is assembled by FlowChartBuilder as each stage is added —
 * no post-processing walk of buildTimeStructure is needed or performed here.
 */
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Generates an OpenAPI 3.1 spec from a FlowChartContract.
 * Uses `chart.description` which FlowChartBuilder assembles at build time —
 * no post-processing walk of buildTimeStructure is performed here.
 */
export function generateOpenAPI(contract, options) {
    const { chart, inputSchema, outputSchema } = contract;
    const version = options?.version ?? '1.0.0';
    const basePath = options?.basePath ?? '/';
    const method = options?.method ?? 'post';
    const rootName = chart.root.name;
    const operationId = slugify(rootName);
    const path = `${basePath === '/' ? '' : basePath}/${operationId}`;
    // Description was built incrementally during FlowChartBuilder.build() — read it directly.
    const fullDescription = chart.description;
    // Build schemas for components
    const schemas = {};
    const inputRef = `${rootName}Input`;
    const outputRef = `${rootName}Output`;
    if (inputSchema)
        schemas[inputRef] = inputSchema;
    if (outputSchema)
        schemas[outputRef] = outputSchema;
    // Build operation
    const operation = {
        operationId,
        summary: rootName,
        description: fullDescription,
        ...(inputSchema
            ? {
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: `#/components/schemas/${inputRef}` },
                        },
                    },
                },
            }
            : {}),
        responses: {
            '200': {
                description: 'Successful execution',
                ...(outputSchema
                    ? {
                        content: {
                            'application/json': {
                                schema: { $ref: `#/components/schemas/${outputRef}` },
                            },
                        },
                    }
                    : {}),
            },
            '500': {
                description: 'Pipeline execution error',
            },
        },
    };
    const spec = {
        openapi: '3.1.0',
        info: {
            title: rootName,
            description: fullDescription,
            version,
        },
        paths: {
            [path]: {
                [method]: operation,
            },
        },
        ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
    };
    return spec;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlbmFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvY29udHJhY3Qvb3BlbmFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7OztHQVVHO0FBS0gsZ0ZBQWdGO0FBQ2hGLG1CQUFtQjtBQUNuQixnRkFBZ0Y7QUFFaEYsU0FBUyxPQUFPLENBQUMsSUFBWTtJQUMzQixPQUFPLElBQUk7U0FDUixXQUFXLEVBQUU7U0FDYixPQUFPLENBQUMsYUFBYSxFQUFFLEdBQUcsQ0FBQztTQUMzQixPQUFPLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxnRkFBZ0Y7QUFDaEYsYUFBYTtBQUNiLGdGQUFnRjtBQUVoRjs7OztHQUlHO0FBQ0gsTUFBTSxVQUFVLGVBQWUsQ0FBQyxRQUEyQixFQUFFLE9BQXdCO0lBQ25GLE1BQU0sRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxHQUFHLFFBQVEsQ0FBQztJQUN0RCxNQUFNLE9BQU8sR0FBRyxPQUFPLEVBQUUsT0FBTyxJQUFJLE9BQU8sQ0FBQztJQUM1QyxNQUFNLFFBQVEsR0FBRyxPQUFPLEVBQUUsUUFBUSxJQUFJLEdBQUcsQ0FBQztJQUMxQyxNQUFNLE1BQU0sR0FBRyxPQUFPLEVBQUUsTUFBTSxJQUFJLE1BQU0sQ0FBQztJQUV6QyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztJQUNqQyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDdEMsTUFBTSxJQUFJLEdBQUcsR0FBRyxRQUFRLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsSUFBSSxXQUFXLEVBQUUsQ0FBQztJQUVsRSwwRkFBMEY7SUFDMUYsTUFBTSxlQUFlLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQztJQUUxQywrQkFBK0I7SUFDL0IsTUFBTSxPQUFPLEdBQStCLEVBQUUsQ0FBQztJQUMvQyxNQUFNLFFBQVEsR0FBRyxHQUFHLFFBQVEsT0FBTyxDQUFDO0lBQ3BDLE1BQU0sU0FBUyxHQUFHLEdBQUcsUUFBUSxRQUFRLENBQUM7SUFFdEMsSUFBSSxXQUFXO1FBQUUsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUNqRCxJQUFJLFlBQVk7UUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLEdBQUcsWUFBWSxDQUFDO0lBRXBELGtCQUFrQjtJQUNsQixNQUFNLFNBQVMsR0FBcUI7UUFDbEMsV0FBVztRQUNYLE9BQU8sRUFBRSxRQUFRO1FBQ2pCLFdBQVcsRUFBRSxlQUFlO1FBQzVCLEdBQUcsQ0FBQyxXQUFXO1lBQ2IsQ0FBQyxDQUFDO2dCQUNFLFdBQVcsRUFBRTtvQkFDWCxRQUFRLEVBQUUsSUFBSTtvQkFDZCxPQUFPLEVBQUU7d0JBQ1Asa0JBQWtCLEVBQUU7NEJBQ2xCLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSx3QkFBd0IsUUFBUSxFQUFFLEVBQUU7eUJBQ3JEO3FCQUNGO2lCQUNGO2FBQ0Y7WUFDSCxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ1AsU0FBUyxFQUFFO1lBQ1QsS0FBSyxFQUFFO2dCQUNMLFdBQVcsRUFBRSxzQkFBc0I7Z0JBQ25DLEdBQUcsQ0FBQyxZQUFZO29CQUNkLENBQUMsQ0FBQzt3QkFDRSxPQUFPLEVBQUU7NEJBQ1Asa0JBQWtCLEVBQUU7Z0NBQ2xCLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSx3QkFBd0IsU0FBUyxFQUFFLEVBQUU7NkJBQ3REO3lCQUNGO3FCQUNGO29CQUNILENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDUjtZQUNELEtBQUssRUFBRTtnQkFDTCxXQUFXLEVBQUUsMEJBQTBCO2FBQ3hDO1NBQ0Y7S0FDRixDQUFDO0lBRUYsTUFBTSxJQUFJLEdBQWdCO1FBQ3hCLE9BQU8sRUFBRSxPQUFPO1FBQ2hCLElBQUksRUFBRTtZQUNKLEtBQUssRUFBRSxRQUFRO1lBQ2YsV0FBVyxFQUFFLGVBQWU7WUFDNUIsT0FBTztTQUNSO1FBQ0QsS0FBSyxFQUFFO1lBQ0wsQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDTixDQUFDLE1BQU0sQ0FBQyxFQUFFLFNBQVM7YUFDcEI7U0FDRjtRQUNELEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ3hFLENBQUM7SUFFRixPQUFPLElBQUksQ0FBQztBQUNkLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGNvbnRyYWN0L29wZW5hcGkudHMg4oCUIE9wZW5BUEkgMy4xIHNwZWMgZ2VuZXJhdG9yLlxuICpcbiAqIEdlbmVyYXRlcyBhbiBPcGVuQVBJIHNwZWMgZnJvbSBhIEZsb3dDaGFydENvbnRyYWN0IGJ5IGNvbWJpbmluZzpcbiAqIC0gY2hhcnQuZGVzY3JpcHRpb24g4oaSIG9wZXJhdGlvbiBkZXNjcmlwdGlvbiAoYnVpbHQgaW5jcmVtZW50YWxseSBkdXJpbmcgRmxvd0NoYXJ0QnVpbGRlci5idWlsZCgpKVxuICogLSBpbnB1dFNjaGVtYSDihpIgcmVxdWVzdEJvZHlcbiAqIC0gb3V0cHV0U2NoZW1hIOKGkiByZXNwb25zZVxuICpcbiAqIGNoYXJ0LmRlc2NyaXB0aW9uIGlzIGFzc2VtYmxlZCBieSBGbG93Q2hhcnRCdWlsZGVyIGFzIGVhY2ggc3RhZ2UgaXMgYWRkZWQg4oCUXG4gKiBubyBwb3N0LXByb2Nlc3Npbmcgd2FsayBvZiBidWlsZFRpbWVTdHJ1Y3R1cmUgaXMgbmVlZGVkIG9yIHBlcmZvcm1lZCBoZXJlLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd0NoYXJ0IH0gZnJvbSAnLi4vYnVpbGRlci90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydENvbnRyYWN0LCBKc29uU2NoZW1hLCBPcGVuQVBJT3BlcmF0aW9uLCBPcGVuQVBJT3B0aW9ucywgT3BlbkFQSVNwZWMgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBJbnRlcm5hbCBoZWxwZXJzXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZnVuY3Rpb24gc2x1Z2lmeShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbmFtZVxuICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgJy0nKVxuICAgIC5yZXBsYWNlKC9eLXwtJC9nLCAnJyk7XG59XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gUHVibGljIEFQSVxuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICogR2VuZXJhdGVzIGFuIE9wZW5BUEkgMy4xIHNwZWMgZnJvbSBhIEZsb3dDaGFydENvbnRyYWN0LlxuICogVXNlcyBgY2hhcnQuZGVzY3JpcHRpb25gIHdoaWNoIEZsb3dDaGFydEJ1aWxkZXIgYXNzZW1ibGVzIGF0IGJ1aWxkIHRpbWUg4oCUXG4gKiBubyBwb3N0LXByb2Nlc3Npbmcgd2FsayBvZiBidWlsZFRpbWVTdHJ1Y3R1cmUgaXMgcGVyZm9ybWVkIGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW5lcmF0ZU9wZW5BUEkoY29udHJhY3Q6IEZsb3dDaGFydENvbnRyYWN0LCBvcHRpb25zPzogT3BlbkFQSU9wdGlvbnMpOiBPcGVuQVBJU3BlYyB7XG4gIGNvbnN0IHsgY2hhcnQsIGlucHV0U2NoZW1hLCBvdXRwdXRTY2hlbWEgfSA9IGNvbnRyYWN0O1xuICBjb25zdCB2ZXJzaW9uID0gb3B0aW9ucz8udmVyc2lvbiA/PyAnMS4wLjAnO1xuICBjb25zdCBiYXNlUGF0aCA9IG9wdGlvbnM/LmJhc2VQYXRoID8/ICcvJztcbiAgY29uc3QgbWV0aG9kID0gb3B0aW9ucz8ubWV0aG9kID8/ICdwb3N0JztcblxuICBjb25zdCByb290TmFtZSA9IGNoYXJ0LnJvb3QubmFtZTtcbiAgY29uc3Qgb3BlcmF0aW9uSWQgPSBzbHVnaWZ5KHJvb3ROYW1lKTtcbiAgY29uc3QgcGF0aCA9IGAke2Jhc2VQYXRoID09PSAnLycgPyAnJyA6IGJhc2VQYXRofS8ke29wZXJhdGlvbklkfWA7XG5cbiAgLy8gRGVzY3JpcHRpb24gd2FzIGJ1aWx0IGluY3JlbWVudGFsbHkgZHVyaW5nIEZsb3dDaGFydEJ1aWxkZXIuYnVpbGQoKSDigJQgcmVhZCBpdCBkaXJlY3RseS5cbiAgY29uc3QgZnVsbERlc2NyaXB0aW9uID0gY2hhcnQuZGVzY3JpcHRpb247XG5cbiAgLy8gQnVpbGQgc2NoZW1hcyBmb3IgY29tcG9uZW50c1xuICBjb25zdCBzY2hlbWFzOiBSZWNvcmQ8c3RyaW5nLCBKc29uU2NoZW1hPiA9IHt9O1xuICBjb25zdCBpbnB1dFJlZiA9IGAke3Jvb3ROYW1lfUlucHV0YDtcbiAgY29uc3Qgb3V0cHV0UmVmID0gYCR7cm9vdE5hbWV9T3V0cHV0YDtcblxuICBpZiAoaW5wdXRTY2hlbWEpIHNjaGVtYXNbaW5wdXRSZWZdID0gaW5wdXRTY2hlbWE7XG4gIGlmIChvdXRwdXRTY2hlbWEpIHNjaGVtYXNbb3V0cHV0UmVmXSA9IG91dHB1dFNjaGVtYTtcblxuICAvLyBCdWlsZCBvcGVyYXRpb25cbiAgY29uc3Qgb3BlcmF0aW9uOiBPcGVuQVBJT3BlcmF0aW9uID0ge1xuICAgIG9wZXJhdGlvbklkLFxuICAgIHN1bW1hcnk6IHJvb3ROYW1lLFxuICAgIGRlc2NyaXB0aW9uOiBmdWxsRGVzY3JpcHRpb24sXG4gICAgLi4uKGlucHV0U2NoZW1hXG4gICAgICA/IHtcbiAgICAgICAgICByZXF1ZXN0Qm9keToge1xuICAgICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgICAgICBjb250ZW50OiB7XG4gICAgICAgICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzoge1xuICAgICAgICAgICAgICAgIHNjaGVtYTogeyAkcmVmOiBgIy9jb21wb25lbnRzL3NjaGVtYXMvJHtpbnB1dFJlZn1gIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH1cbiAgICAgIDoge30pLFxuICAgIHJlc3BvbnNlczoge1xuICAgICAgJzIwMCc6IHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdTdWNjZXNzZnVsIGV4ZWN1dGlvbicsXG4gICAgICAgIC4uLihvdXRwdXRTY2hlbWFcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgY29udGVudDoge1xuICAgICAgICAgICAgICAgICdhcHBsaWNhdGlvbi9qc29uJzoge1xuICAgICAgICAgICAgICAgICAgc2NoZW1hOiB7ICRyZWY6IGAjL2NvbXBvbmVudHMvc2NoZW1hcy8ke291dHB1dFJlZn1gIH0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0sXG4gICAgICAnNTAwJzoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1BpcGVsaW5lIGV4ZWN1dGlvbiBlcnJvcicsXG4gICAgICB9LFxuICAgIH0sXG4gIH07XG5cbiAgY29uc3Qgc3BlYzogT3BlbkFQSVNwZWMgPSB7XG4gICAgb3BlbmFwaTogJzMuMS4wJyxcbiAgICBpbmZvOiB7XG4gICAgICB0aXRsZTogcm9vdE5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogZnVsbERlc2NyaXB0aW9uLFxuICAgICAgdmVyc2lvbixcbiAgICB9LFxuICAgIHBhdGhzOiB7XG4gICAgICBbcGF0aF06IHtcbiAgICAgICAgW21ldGhvZF06IG9wZXJhdGlvbixcbiAgICAgIH0sXG4gICAgfSxcbiAgICAuLi4oT2JqZWN0LmtleXMoc2NoZW1hcykubGVuZ3RoID4gMCA/IHsgY29tcG9uZW50czogeyBzY2hlbWFzIH0gfSA6IHt9KSxcbiAgfTtcblxuICByZXR1cm4gc3BlYztcbn1cbiJdfQ==