declare module "@webex/plugin-encryption" {
  const Webex: {
    init(input: {
      credentials: { access_token: string };
    }): unknown;
  };

  export default Webex;
}
