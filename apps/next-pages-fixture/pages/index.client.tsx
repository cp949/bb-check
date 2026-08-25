import type { GetServerSideProps } from "next";
// @ts-expect-error 실제 배포 JavaScript fixture는 declaration 없이 소비한다.
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
