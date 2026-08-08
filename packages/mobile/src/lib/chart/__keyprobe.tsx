export function Probe({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <span key={`${index}-${line}`}>{line}</span>
      ))}
    </>
  );
}
