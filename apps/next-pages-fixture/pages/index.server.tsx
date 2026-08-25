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
  // @ts-expect-error server-only JavaScript entrypoint도 실제 배포 형상을 사용한다.
  const { readFixture } = await import("syntax-fixture/server");
  return { props: { serverValue: readFixture() } };
};
