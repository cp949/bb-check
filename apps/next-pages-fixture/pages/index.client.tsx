import type { GetServerSideProps } from "next";
import { readFixture as readClientFixture } from "syntax-fixture";

interface HomeProps {
  readonly serverValue: string;
}

export default function Home({ serverValue }: HomeProps) {
  return (
    <main>
      <p>{readClientFixture()}</p>
      <p>{serverValue}</p>
    </main>
  );
}

export const getServerSideProps: GetServerSideProps<HomeProps> = async () => ({
  props: { serverValue: "client fixture" },
});
