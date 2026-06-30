/**
 * Renders a JSON-LD <script> for schema.org structured data. Server
 * component (emits no client JS). `data` is a single schema object or an
 * array of them. The markup is our own static structured data, never user
 * input, so dangerouslySetInnerHTML is safe here.
 */
export default function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
