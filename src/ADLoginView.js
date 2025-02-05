// @flow
import React, { Component } from "react";
import { WebView, Dimensions, AsyncStorage, Platform } from "react-native";
import CONST from "./const.js";
import ReactNativeAD from "./ReactNativeAD.js";
import Timer from "react-timer-mixin";
import log from "./logger";

const loginUrl =
  "https://login.microsoftonline.com/<tenant id>/oauth2/authorize";
const tokenUrl = "https://login.microsoftonline.com/common/oauth2/token";

export default class ADLoginView extends React.Component {
  props: {
    onSuccess?: ?Function,
    needLogout?: boolean,
    style: any,
    onURLChange: Function,
    context: ReactNativeAD,
    hideAfterLogin?: boolean
  };

  state: {
    page: string,
    visible: boolean
  };

  static defaultProps = {
    authority_host: loginUrl,
    tenant: "common",
    onSuccess: () => {},
    onPageRequest: null
  };

  _needRedirect: boolean;
  _onTokenGranted: () => {};
  _lock: boolean;
  _accessToken: Object;
  _resourceForWhichAccessTokenIsFetchedByGet: string;

  constructor(props: any) {
    super(props);
    if (!this.props.context instanceof ReactNativeAD)
      throw new Error(
        "property `context` of ADLoginView should be an instance of ReactNativeAD, but got",
        this.props.context
      );
    let context = this.props.context;
    let tenant = context.getConfig().tenant;
    this._needRedirect = this.props.needLogout || false;
    this.state = {
      page: this._getLoginUrl(tenant || "common"),
      visible: true
    };
    this._lock = false;
  }

  componentWillUpdate(nextProps: any, nextState: any): any {
    if (
      this.state.visible === nextState.visible &&
      this.state.page === nextState.page
    )
      return false;
    return true;
  }

  componentDidUpdate(prevProps: any, prevState: any) {
    if (prevState.visible !== this.state.visible)
      this.props.onVisibilityChange &&
        this.props.onVisibilityChange(this.state.visible);
    log.debug("ADLoginView updated.");
  }

  componentWillReceiveProps(nextProps) {
    if (!this.props.needLogout && nextProps.needLogout) {
      let context = this.props.context;
      let tenant = context.getConfig().tenant;
      this._needRedirect = nextProps.needLogout || false;
      this.setState({
        page: this._getLoginUrl(tenant || "common"),
        visible: true
      });
    }
  }

  render() {
    // Fix visibility problem on Android webview
    let js = `document.getElementsByTagName('body')[0].style.height = '${
      Dimensions.get("window").height
    }px';`;

    return this.state.visible ? (
      <WebView
        ref="ADLoginView"
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        style={[
          this.props.style,
          {
            flex: 1,
            alignSelf: "stretch",
            width: Dimensions.get("window").width,
            height: Dimensions.get("window").height
          }
        ]}
        source={{ uri: this.state.page }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onLoadEnd={() => {
          if (this._needRedirect) {
            this._needRedirect = false;
            let tenant = this.props.context.getConfig().tenant || "common";
            this.setState({ page: this._getLoginUrl(tenant) });
          }
        }}
        decelerationRate="normal"
        javaScriptEnabledAndroid={true}
        onNavigationStateChange={this._handleADToken.bind(this)}
        onShouldStartLoadWithRequest={e => {
          return true;
        }}
        startInLoadingState={false}
        injectedJavaScript={js}
        scalesPageToFit={true}
      />
    ) : null;
  }

  /**
   * Get authority host URI,
   * @param {string} tenant Custom tenant ID, this filed is optional, default
   *                        values is `common`.
   * @return {string} The Authority host URI.
   */
  _getLoginUrl(tenant: string = "common"): string {
    let authUrl = String(this.props.authority_host || loginUrl).replace(
      "<tenant id>",
      tenant
    );
    let context = this.props.context || null;
    let redirect = context.getConfig().redirect_uri;
    let prompt = context.getConfig().prompt;

    if (context !== null) {
      let result =
        `${authUrl}?response_type=code` +
        `&client_id=${context.getConfig().client_id}` +
        (redirect
          ? `&redirect_uri=${
              context.getConfig().redirect_uri
            }&nonce=rnad-${Date.now()}`
          : "") +
        (prompt ? `&prompt=${context.getConfig().prompt}` : "");

      if (this._needRedirect)
        result = `https://login.windows.net/${
          this.props.context.getConfig().client_id
        }/oauth2/logout`;
      return result;
    } else {
      throw new Error("AD context should not be null/undefined.");
    }
  }

  _getAcquireTokenPopupUrl(
    tenant: string,
    resource: string,
    response_type: string
  ): string {
    let context = this.props.context;
    let redirect = context.getConfig().redirect_uri;
    return (
      `https://login.microsoftonline.com/${tenant}/oauth2/authorize?response_type=${response_type}&resource=${resource}` +
      `&client_id=${context.getConfig().client_id}` +
      `&scope=openid` +
      (redirect
        ? `&redirect_uri=${
            context.getConfig().redirect_uri
          }&nonce=rnad-${Date.now()}`
        : "")
    );
  }

  /**
   * An interceptor for handling webview url change, when it detects possible
   * authorization code in url, it will triggers authentication flow.
   * @param  {object} e Navigation state change event object.
   */
  _handleADToken(e: { url: string }): any {
    log.verbose("ADLoginView navigate to", e.url);
    if (this._lock) return true;
    let code = /((\?|\&)code\=)[^\&]+/.exec(e.url);

    if (this._needRedirect) {
      // this._needRedirect = false
      return true;
    }

    if (this.props.onURLChange) {
      this.props.onURLChange(e);
    }

    if (e.url.indexOf("access_token") > -1) {
      this.setState({ visible: true });
      this.props.onVisibilityChange && this.props.onVisibilityChange(false);

      // Once access_token is fetched, go back to login, this time auth will go fine.
      this.setState({
        page: this._getLoginUrl(this.props.context.getConfig().tenant)
      });

      return true;
    }

    if (code !== null) {
      this._lock = true;
      log.verbose("ADLoginView._handleADToken code=", code[0]);
      code = String(code[0]).replace(/(\?|\&)?code\=/, "");
      this.setState({ visible: !this.props.hideAfterLogin });
      this.props.onVisibilityChange && this.props.onVisibilityChange(false);
      this._getResourceAccessToken(code).catch(err => {
        // log.error('ADLoginView._getResourceAccessToken', err)
        console.log("Could not get resource access token");
      });
      return true;
    }

    return true;
  }

  /**
   * Check required properies and show error.
   * @param  {ReactNativeADConfig} config Configration object input.
   */
  _checkProperties(config: any) {
    ["client_id", "redirect_uri", "authority_host"].forEach(prop => {
      if (!config.hasOwnProperty(prop))
        throw new Error(
          `ReactNativeAD config object must have \`${prop}\` property`
        );
    });
  }

  /**
   * Get access token for each resoureces
   * @param {string} code The authorization code from `onNavigationStateChange`
   *                      callback.
   * @return {Promise<void>}
   */
  _getResourceAccessToken(code: string): Promise {
    let context = this.props.context;

    if (!context)
      throw new Error(
        "property `context` of ADLoginView should not be null/undefined"
      );

    let adConfig: ADConfig = this.props.context.getConfig();

    let {
      client_id = null,
      redirect_uri = null,
      client_secret = null,
      resources = null
    } = adConfig;
    // Transform resource string to array
    if (typeof resources === "string") resources = [resources];
    else if (Array.isArray(resources))
      resources = resources.length === 0 ? null : resources;

    log.verbose("ADLoginView get access token for resources=", resources);

    let promises: Array<Promise> = [];
    let config = {
      client_id,
      redirect_uri,
      code,
      client_secret,
      // set resource to common by default
      resource: "common"
    };

    if (resources === null || resources === void 0) {
      promises.push(
        context.grantAccessToken(CONST.GRANT_TYPE.AUTHORIZATION_CODE, config)
      );
    }
    // Get access_token for each resource
    else {
      promises = resources.map((rcs, i) => {
        let cfg = Object.assign({}, config, { resource: rcs });
        return context.grantAccessToken(
          CONST.GRANT_TYPE.AUTHORIZATION_CODE,
          cfg
        );
      });
    }
    return Promise.all(promises)
      .then((resps: Array<GrantTokenResp>) => {
        log.verbose("ADLoginView response access info ", resps);

        if (!this.props.context) {
          throw new Error(
            "value of property `context` is invalid=",
            this.props.context
          );
        }
        let context = this.props.context;
        let onSuccess = this.props.onSuccess || function() {};

        // trigger loggined finished event
        if (context !== null && typeof this.props.onSuccess === "function") {
          onSuccess(context.getCredentials());
        }
        this._lock = false;
      })
      .catch(err => {
        this._resourceForWhichAccessTokenIsFetchedByGet = err.resource;
        if (err.response.error.indexOf("interaction_required") > -1) {
          this.setState({ visible: true });
          this._lock = false;
          this.props.onVisibilityChange && this.props.onVisibilityChange(false);
          this.setState({
            page: this._getAcquireTokenPopupUrl(
              context.getConfig().tenant,
              err.resource,
              "token"
            )
          });
        } else {
          throw new Error("Failed to acquire token for resources", err.stack);
        }
      });
  }
}
