import type { GetServerSideProps } from "next";

interface HomeProps {
  readonly serverValue: string;
}

export default function Home({ serverValue }: HomeProps) {
  return (
    <main>
      <p>{serverValue}</p>
    </main>
  );
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async () => {
  const { readFixture } = await import("syntax-fixture/server");
  return { props: { serverValue: readFixture() } };
};
