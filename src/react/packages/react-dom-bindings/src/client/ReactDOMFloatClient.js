/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 *
 */

import { isAttributeNameSafe } from "../shared/DOMProperty";
import { precacheFiberNode } from "./ReactDOMComponentTree";

import ReactDOMSharedInternals from "shared/ReactDOMSharedInternals.js";
const { Dispatcher } = ReactDOMSharedInternals;
import { DOCUMENT_NODE } from "../shared/HTMLNodeType";
import {
  validatePreloadArguments,
  validatePreinitArguments,
} from "../shared/ReactDOMResourceValidation";
import { createElement, setInitialProperties } from "./ReactDOMComponent";
import {
  checkAttributeStringCoercion,
  checkPropStringCoercion,
} from "shared/CheckStringCoercion";
import {
  getResourcesFromRoot,
  isMarkedResource,
  markNodeAsResource,
} from "./ReactDOMComponentTree";
import { HTML_NAMESPACE, SVG_NAMESPACE } from "../shared/DOMNamespaces";
import { getCurrentRootHostContainer } from "react-reconciler/src/ReactFiberHostContext";

// The resource types we support. currently they match the form for the as argument.
// In the future this may need to change, especially when modules / scripts are supported

// It is valid to preload even when we aren't actively rendering. For cases where Float functions are
// called when there is no rendering we track the last used document. It is not safe to insert
// arbitrary resources into the lastCurrentDocument b/c it may not actually be the document
// that the resource is meant to apply too (for example stylesheets or scripts). This is only
// appropriate for resources that don't really have a strict tie to the document itself for example
// preloads
let lastCurrentDocument = null;

let previousDispatcher = null;
export function prepareToRenderResources(rootContainer) {
  const rootNode = getHoistableRoot(rootContainer);
  lastCurrentDocument = getDocumentFromRoot(rootNode);

  previousDispatcher = Dispatcher.current;
  Dispatcher.current = ReactDOMClientDispatcher;
}

export function cleanupAfterRenderResources() {
  Dispatcher.current = previousDispatcher;
  previousDispatcher = null;
}

// We want this to be the default dispatcher on ReactDOMSharedInternals but we don't want to mutate
// internals in Module scope. Instead we export it and Internals will import it. There is already a cycle
// from Internals -> ReactDOM -> FloatClient -> Internals so this doesn't introduce a new one.
export const ReactDOMClientDispatcher = { preload, preinit };

// global maps of Resources
const preloadPropsMap = new Map();

// getRootNode is missing from IE and old jsdom versions
export function getHoistableRoot(container) {
  // $FlowFixMe[method-unbinding]
  return typeof container.getRootNode === "function"
    ? /* $FlowFixMe[incompatible-return] Flow types this as returning a `Node`,
       * but it's either a `Document` or `ShadowRoot`. */
      container.getRootNode()
    : container.ownerDocument;
}

function getCurrentResourceRoot() {
  const currentContainer = getCurrentRootHostContainer();
  return currentContainer ? getHoistableRoot(currentContainer) : null;
}

// Preloads are somewhat special. Even if we don't have the Document
// used by the root that is rendering a component trying to insert a preload
// we can still seed the file cache by doing the preload on any document we have
// access to. We prefer the currentDocument if it exists, we also prefer the
// lastCurrentDocument if that exists. As a fallback we will use the window.document
// if available.
function getDocumentForPreloads() {
  const root = getCurrentResourceRoot();
  if (root) {
    return root.ownerDocument || root;
  } else {
    try {
      return lastCurrentDocument || window.document;
    } catch (error) {
      return null;
    }
  }
}

function getDocumentFromRoot(root) {
  return root.ownerDocument || root;
}

// --------------------------------------
//      ReactDOM.Preload
// --------------------------------------

function preload(href, options) {
  if (__DEV__) {
    validatePreloadArguments(href, options);
  }
  const ownerDocument = getDocumentForPreloads();
  if (
    typeof href === "string" &&
    href &&
    typeof options === "object" &&
    options !== null &&
    ownerDocument
  ) {
    const as = options.as;
    const limitedEscapedHref =
      escapeSelectorAttributeValueInsideDoubleQuotes(href);
    const preloadKey = `link[rel="preload"][as="${as}"][href="${limitedEscapedHref}"]`;
    let key = preloadKey;
    switch (as) {
      case "style":
        key = getStyleKey(href);
        break;
      case "script":
        key = getScriptKey(href);
        break;
    }
    if (!preloadPropsMap.has(key)) {
      const preloadProps = preloadPropsFromPreloadOptions(href, as, options);
      preloadPropsMap.set(key, preloadProps);

      if (null === ownerDocument.querySelector(preloadKey)) {
        const preloadInstance = createElement(
          "link",
          preloadProps,
          ownerDocument,
          HTML_NAMESPACE
        );
        setInitialProperties(preloadInstance, "link", preloadProps);
        markNodeAsResource(preloadInstance);
        ownerDocument.head.appendChild(preloadInstance);
      }
    }
  }
}

function preloadPropsFromPreloadOptions(href, as, options) {
  return {
    href,
    rel: "preload",
    as,
    crossOrigin: as === "font" ? "" : options.crossOrigin,
    integrity: options.integrity,
  };
}

// --------------------------------------
//      ReactDOM.preinit
// --------------------------------------

function preinit(href, options) {
  if (__DEV__) {
    validatePreinitArguments(href, options);
  }

  if (
    typeof href === "string" &&
    href &&
    typeof options === "object" &&
    options !== null
  ) {
    const resourceRoot = getCurrentResourceRoot();
    const as = options.as;
    if (!resourceRoot) {
      if (as === "style" || as === "script") {
        // We are going to emit a preload as a best effort fallback since this preinit
        // was called outside of a render. Given the passive nature of this fallback
        // we do not warn in dev when props disagree if there happens to already be a
        // matching preload with this href
        const preloadDocument = getDocumentForPreloads();
        if (preloadDocument) {
          const limitedEscapedHref =
            escapeSelectorAttributeValueInsideDoubleQuotes(href);
          const preloadKey = `link[rel="preload"][as="${as}"][href="${limitedEscapedHref}"]`;
          let key = preloadKey;
          switch (as) {
            case "style":
              key = getStyleKey(href);
              break;
            case "script":
              key = getScriptKey(href);
              break;
          }
          if (!preloadPropsMap.has(key)) {
            const preloadProps = preloadPropsFromPreinitOptions(
              href,
              as,
              options
            );
            preloadPropsMap.set(key, preloadProps);

            if (null === preloadDocument.querySelector(preloadKey)) {
              const preloadInstance = createElement(
                "link",
                preloadProps,
                preloadDocument,
                HTML_NAMESPACE
              );
              setInitialProperties(preloadInstance, "link", preloadProps);
              markNodeAsResource(preloadInstance);
              preloadDocument.head.appendChild(preloadInstance);
            }
          }
        }
      }
      return;
    }

    switch (as) {
      case "style": {
        const styles = getResourcesFromRoot(resourceRoot).hoistableStyles;

        const key = getStyleKey(href);
        const precedence = options.precedence || "default";

        // Check if this resource already exists
        let resource = styles.get(key);
        if (resource) {
          // We can early return. The resource exists and there is nothing
          // more to do
          return;
        }

        // Attempt to hydrate instance from DOM
        let instance = resourceRoot.querySelector(
          getStylesheetSelectorFromKey(key)
        );
        if (!instance) {
          // Construct a new instance and insert it
          const stylesheetProps = stylesheetPropsFromPreinitOptions(
            href,
            precedence,
            options
          );
          const preloadProps = preloadPropsMap.get(key);
          if (preloadProps) {
            adoptPreloadPropsForStylesheet(stylesheetProps, preloadProps);
          }
          instance = createElement(
            "link",
            stylesheetProps,
            resourceRoot,
            HTML_NAMESPACE
          );
          markNodeAsResource(instance);
          setInitialProperties(instance, "link", stylesheetProps);
          insertStylesheet(instance, precedence, resourceRoot);
        }

        // Construct a Resource and cache it
        resource = {
          type: "stylesheet",
          instance,
          count: 1,
        };
        styles.set(key, resource);
        return;
      }
      case "script": {
        const src = href;
        const scripts = getResourcesFromRoot(resourceRoot).hoistableScripts;

        const key = getScriptKey(src);

        // Check if this resource already exists
        let resource = scripts.get(key);
        if (resource) {
          // We can early return. The resource exists and there is nothing
          // more to do
          return;
        }

        // Attempt to hydrate instance from DOM
        let instance = resourceRoot.querySelector(
          getScriptSelectorFromKey(key)
        );
        if (!instance) {
          // Construct a new instance and insert it
          const scriptProps = scriptPropsFromPreinitOptions(src, options);
          // Adopt certain preload props
          const preloadProps = preloadPropsMap.get(key);
          if (preloadProps) {
            adoptPreloadPropsForScript(scriptProps, preloadProps);
          }
          instance = createElement(
            "script",
            scriptProps,
            resourceRoot,
            HTML_NAMESPACE
          );
          markNodeAsResource(instance);
          setInitialProperties(instance, "link", scriptProps);
          getDocumentFromRoot(resourceRoot).head.appendChild(instance);
        }

        // Construct a Resource and cache it
        resource = {
          type: "script",
          instance,
          count: 1,
        };
        scripts.set(key, resource);
        return;
      }
    }
  }
}

function preloadPropsFromPreinitOptions(href, as, options) {
  return {
    href,
    rel: "preload",
    as,
    crossOrigin: as === "font" ? "" : options.crossOrigin,
    integrity: options.integrity,
  };
}

function stylesheetPropsFromPreinitOptions(href, precedence, options) {
  return {
    rel: "stylesheet",
    href,
    "data-precedence": precedence,
    crossOrigin: options.crossOrigin,
  };
}

function scriptPropsFromPreinitOptions(src, options) {
  return {
    src,
    async: true,
    crossOrigin: options.crossOrigin,
    integrity: options.integrity,
  };
}

// --------------------------------------
//      Resources from render
// --------------------------------------

// This function is called in begin work and we should always have a currentDocument set
export function getResource(type, currentProps, pendingProps) {
  const resourceRoot = getCurrentResourceRoot();
  if (!resourceRoot) {
    throw new Error(
      '"resourceRoot" was expected to exist. This is a bug in React.'
    );
  }
  switch (type) {
    case "meta":
    case "title": {
      return null;
    }
    case "style": {
      if (
        typeof pendingProps.precedence === "string" &&
        typeof pendingProps.href === "string"
      ) {
        const key = getStyleKey(pendingProps.href);
        const styles = getResourcesFromRoot(resourceRoot).hoistableStyles;
        let resource = styles.get(key);
        if (!resource) {
          resource = {
            type: "style",
            instance: null,
            count: 0,
          };
          styles.set(key, resource);
        }
        return resource;
      }
      return {
        type: "void",
        instance: null,
        count: 0,
      };
    }
    case "link": {
      if (
        pendingProps.rel === "stylesheet" &&
        typeof pendingProps.href === "string" &&
        typeof pendingProps.precedence === "string"
      ) {
        const qualifiedProps = pendingProps;
        const key = getStyleKey(qualifiedProps.href);

        const styles = getResourcesFromRoot(resourceRoot).hoistableStyles;

        let resource = styles.get(key);
        if (!resource) {
          // We asserted this above but Flow can't figure out that the type satisfies
          const ownerDocument = getDocumentFromRoot(resourceRoot);
          resource = {
            type: "stylesheet",
            instance: null,
            count: 0,
          };
          styles.set(key, resource);
          if (!preloadPropsMap.has(key)) {
            preloadStylesheet(
              ownerDocument,
              key,
              preloadPropsFromStylesheet(qualifiedProps)
            );
          }
        }
        return resource;
      }
      return null;
    }
    case "script": {
      if (typeof pendingProps.src === "string" && pendingProps.async === true) {
        const scriptProps = pendingProps;
        const key = getScriptKey(scriptProps.src);
        const scripts = getResourcesFromRoot(resourceRoot).hoistableScripts;

        let resource = scripts.get(key);
        if (!resource) {
          resource = {
            type: "script",
            instance: null,
            count: 0,
          };
          scripts.set(key, resource);
        }
        return resource;
      }
      return {
        type: "void",
        instance: null,
        count: 0,
      };
    }
    default: {
      throw new Error(
        `getResource encountered a type it did not expect: "${type}". this is a bug in React.`
      );
    }
  }
}

function styleTagPropsFromRawProps(rawProps) {
  return {
    ...rawProps,
    "data-href": rawProps.href,
    "data-precedence": rawProps.precedence,
    href: null,
    precedence: null,
  };
}

function getStyleKey(href) {
  const limitedEscapedHref =
    escapeSelectorAttributeValueInsideDoubleQuotes(href);
  return `href="${limitedEscapedHref}"`;
}

function getStyleTagSelectorFromKey(key) {
  return `style[data-${key}]`;
}

function getStylesheetSelectorFromKey(key) {
  return `link[rel="stylesheet"][${key}]`;
}

function getPreloadStylesheetSelectorFromKey(key) {
  return `link[rel="preload"][as="style"][${key}]`;
}

function stylesheetPropsFromRawProps(rawProps) {
  return {
    ...rawProps,
    "data-precedence": rawProps.precedence,
    precedence: null,
  };
}

function preloadStylesheet(ownerDocument, key, preloadProps) {
  preloadPropsMap.set(key, preloadProps);

  if (!ownerDocument.querySelector(getStylesheetSelectorFromKey(key))) {
    // There is no matching stylesheet instance in the Document.
    // We will insert a preload now to kick off loading because
    // we expect this stylesheet to commit
    if (
      null ===
      ownerDocument.querySelector(getPreloadStylesheetSelectorFromKey(key))
    ) {
      const preloadInstance = createElement(
        "link",
        preloadProps,
        ownerDocument,
        HTML_NAMESPACE
      );
      setInitialProperties(preloadInstance, "link", preloadProps);
      markNodeAsResource(preloadInstance);
      ownerDocument.head.appendChild(preloadInstance);
    }
  }
}

function preloadPropsFromStylesheet(props) {
  return {
    rel: "preload",
    as: "style",
    href: props.href,
    crossOrigin: props.crossOrigin,
    integrity: props.integrity,
    media: props.media,
    hrefLang: props.hrefLang,
    referrerPolicy: props.referrerPolicy,
  };
}

function getScriptKey(src) {
  const limitedEscapedSrc = escapeSelectorAttributeValueInsideDoubleQuotes(src);
  return `[src="${limitedEscapedSrc}"]`;
}

function getScriptSelectorFromKey(key) {
  return "script[async]" + key;
}

// --------------------------------------
//      Hoistable Resource Reconciliation
// --------------------------------------

export function acquireResource(hoistableRoot, resource, props) {
  resource.count++;
  if (resource.instance === null) {
    switch (resource.type) {
      case "style": {
        const qualifiedProps = props;
        const key = getStyleKey(qualifiedProps.href);

        // Attempt to hydrate instance from DOM
        let instance = hoistableRoot.querySelector(
          getStyleTagSelectorFromKey(key)
        );
        if (instance) {
          resource.instance = instance;
          return instance;
        }

        const styleProps = styleTagPropsFromRawProps(props);
        instance = createElement(
          "style",
          styleProps,
          hoistableRoot,
          HTML_NAMESPACE
        );

        markNodeAsResource(instance);
        setInitialProperties(instance, "style", styleProps);
        insertStylesheet(instance, qualifiedProps.precedence, hoistableRoot);
        resource.instance = instance;

        return instance;
      }
      case "stylesheet": {
        // This typing is enforce by `getResource`. If we change the logic
        // there for what qualifies as a stylesheet resource we need to ensure
        // this cast still makes sense;
        const qualifiedProps = props;
        const key = getStyleKey(qualifiedProps.href);

        // Attempt to hydrate instance from DOM
        let instance = hoistableRoot.querySelector(
          getStylesheetSelectorFromKey(key)
        );
        if (instance) {
          resource.instance = instance;
          return instance;
        }

        const stylesheetProps = stylesheetPropsFromRawProps(props);
        const preloadProps = preloadPropsMap.get(key);
        if (preloadProps) {
          adoptPreloadPropsForStylesheet(stylesheetProps, preloadProps);
        }

        // Construct and insert a new instance
        instance = createElement(
          "link",
          stylesheetProps,
          hoistableRoot,
          HTML_NAMESPACE
        );
        markNodeAsResource(instance);
        const linkInstance = instance;
        linkInstance._p = new Promise((resolve, reject) => {
          linkInstance.onload = resolve;
          linkInstance.onerror = reject;
        }).then(
          () => (linkInstance._p.s = "l"),
          () => (linkInstance._p.s = "e")
        );
        setInitialProperties(instance, "link", stylesheetProps);
        insertStylesheet(instance, qualifiedProps.precedence, hoistableRoot);
        resource.instance = instance;

        return instance;
      }
      case "script": {
        // This typing is enforce by `getResource`. If we change the logic
        // there for what qualifies as a stylesheet resource we need to ensure
        // this cast still makes sense;
        const borrowedScriptProps = props;
        const key = getScriptKey(borrowedScriptProps.src);

        // Attempt to hydrate instance from DOM
        let instance = hoistableRoot.querySelector(
          getScriptSelectorFromKey(key)
        );
        if (instance) {
          resource.instance = instance;
          return instance;
        }

        let scriptProps = borrowedScriptProps;
        const preloadProps = preloadPropsMap.get(key);
        if (preloadProps) {
          scriptProps = { ...borrowedScriptProps };
          adoptPreloadPropsForScript(scriptProps, preloadProps);
        }

        // Construct and insert a new instance
        instance = createElement(
          "script",
          scriptProps,
          hoistableRoot,
          HTML_NAMESPACE
        );
        markNodeAsResource(instance);
        setInitialProperties(instance, "link", scriptProps);
        getDocumentFromRoot(hoistableRoot).head.appendChild(instance);
        resource.instance = instance;

        return instance;
      }
      case "void": {
        return null;
      }
      default: {
        throw new Error(
          `acquireResource encountered a resource type it did not expect: "${resource.type}". this is a bug in React.`
        );
      }
    }
  }
  return resource.instance;
}

export function releaseResource(resource) {
  resource.count--;
}

function insertStylesheet(instance, precedence, root) {
  const nodes = root.querySelectorAll(
    'link[rel="stylesheet"][data-precedence],style[data-precedence]'
  );
  const last = nodes.length ? nodes[nodes.length - 1] : null;
  let prior = last;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodePrecedence = node.dataset.precedence;
    if (nodePrecedence === precedence) {
      prior = node;
    } else if (prior !== last) {
      break;
    }
  }
  if (prior) {
    // We get the prior from the document so we know it is in the tree.
    // We also know that links can't be the topmost Node so the parentNode
    // must exist.
    prior.parentNode.insertBefore(instance, prior.nextSibling);
  } else {
    const parent = root.nodeType === DOCUMENT_NODE ? root.head : root;
    parent.insertBefore(instance, parent.firstChild);
  }
}

function adoptPreloadPropsForStylesheet(stylesheetProps, preloadProps) {
  if (stylesheetProps.crossOrigin == null)
    stylesheetProps.crossOrigin = preloadProps.crossOrigin;
  if (stylesheetProps.referrerPolicy == null)
    stylesheetProps.referrerPolicy = preloadProps.referrerPolicy;
  if (stylesheetProps.title == null) stylesheetProps.title = preloadProps.title;
}

function adoptPreloadPropsForScript(scriptProps, preloadProps) {
  if (scriptProps.crossOrigin == null)
    scriptProps.crossOrigin = preloadProps.crossOrigin;
  if (scriptProps.referrerPolicy == null)
    scriptProps.referrerPolicy = preloadProps.referrerPolicy;
  if (scriptProps.integrity == null)
    scriptProps.referrerPolicy = preloadProps.integrity;
}

// --------------------------------------
//      Hoistable Element Reconciliation
// --------------------------------------

export function hydrateHoistable(
  hoistableRoot,
  type,
  props,
  internalInstanceHandle
) {
  const ownerDocument = getDocumentFromRoot(hoistableRoot);
  const nodes = ownerDocument.getElementsByTagName(type);

  const children = props.children;
  let child, childString;
  if (Array.isArray(children)) {
    child = children.length === 1 ? children[0] : null;
  } else {
    child = children;
  }
  if (
    typeof child !== "function" &&
    typeof child !== "symbol" &&
    child !== null &&
    child !== undefined
  ) {
    if (__DEV__) {
      checkPropStringCoercion(child, "children");
    }
    childString = "" + child;
  } else {
    childString = "";
  }
  nodeLoop: for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (
      isMarkedResource(node) ||
      node.namespaceURI === SVG_NAMESPACE ||
      node.textContent !== childString
    ) {
      continue;
    }
    let checkedAttributes = 0;
    for (const propName in props) {
      const propValue = props[propName];
      if (!props.hasOwnProperty(propName)) {
        continue;
      }
      switch (propName) {
        // Reserved props will never have an attribute partner
        case "children":
        case "defaultValue":
        case "dangerouslySetInnerHTML":
        case "defaultChecked":
        case "innerHTML":
        case "suppressContentEditableWarning":
        case "suppressHydrationWarning":
        case "style":
          // we advance to the next prop
          continue;

        // Name remapped props used by hoistable tag types
        case "className": {
          if (__DEV__) {
            checkAttributeStringCoercion(propValue, propName);
          }
          if (node.getAttribute("class") !== "" + propValue) continue nodeLoop;
          break;
        }
        case "httpEquiv": {
          if (__DEV__) {
            checkAttributeStringCoercion(propValue, propName);
          }
          if (node.getAttribute("http-equiv") !== "" + propValue)
            continue nodeLoop;
          break;
        }

        // Booleanish props used by hoistable tag types
        case "contentEditable":
        case "draggable":
        case "spellCheck": {
          if (__DEV__) {
            checkAttributeStringCoercion(propValue, propName);
          }
          if (node.getAttribute(propName) !== "" + propValue) continue nodeLoop;
          break;
        }

        // Boolean props used by hoistable tag types
        case "async":
        case "defer":
        case "disabled":
        case "hidden":
        case "noModule":
        case "scoped":
        case "itemScope":
          if (propValue !== node.hasAttribute(propName)) continue nodeLoop;
          break;

        // The following properties are left out because they do not apply to
        // the current set of hoistable types. They may have special handling
        // requirements if they end up applying to a hoistable type in the future
        // case 'acceptCharset':
        // case 'value':
        // case 'allowFullScreen':
        // case 'autoFocus':
        // case 'autoPlay':
        // case 'controls':
        // case 'default':
        // case 'disablePictureInPicture':
        // case 'disableRemotePlayback':
        // case 'formNoValidate':
        // case 'loop':
        // case 'noValidate':
        // case 'open':
        // case 'playsInline':
        // case 'readOnly':
        // case 'required':
        // case 'reversed':
        // case 'seamless':
        // case 'multiple':
        // case 'selected':
        // case 'capture':
        // case 'download':
        // case 'cols':
        // case 'rows':
        // case 'size':
        // case 'span':
        // case 'rowSpan':
        // case 'start':

        default:
          if (isAttributeNameSafe(propName)) {
            const attributeName = propName;
            if (propValue == null && node.hasAttribute(attributeName))
              continue nodeLoop;
            if (__DEV__) {
              checkAttributeStringCoercion(propValue, attributeName);
            }
            if (node.getAttribute(attributeName) !== "" + propValue)
              continue nodeLoop;
          }
      }
      checkedAttributes++;
    }

    if (node.attributes.length !== checkedAttributes) {
      // We didn't match ever attribute so we abandon this node
      continue nodeLoop;
    }

    // We found a matching instance. We can return early after marking it
    markNodeAsResource(node);
    return node;
  }

  // There is no matching instance to hydrate, we create it now
  const instance = createElement(type, props, ownerDocument, HTML_NAMESPACE);
  setInitialProperties(instance, type, props);
  precacheFiberNode(internalInstanceHandle, instance);
  markNodeAsResource(instance);

  ownerDocument.head.insertBefore(
    instance,
    type === "title" ? ownerDocument.querySelector("head > title") : null
  );
  return instance;
}

export function mountHoistable(hoistableRoot, type, instance) {
  const ownerDocument = getDocumentFromRoot(hoistableRoot);
  ownerDocument.head.insertBefore(
    instance,
    type === "title" ? ownerDocument.querySelector("head > title") : null
  );
}

export function unmountHoistable(instance) {
  instance.parentNode.removeChild(instance);
}

// When passing user input into querySelector(All) the embedded string must not alter
// the semantics of the query. This escape function is safe to use when we know the
// provided value is going to be wrapped in double quotes as part of an attribute selector
// Do not use it anywhere else
// we escape double quotes and backslashes
const escapeSelectorAttributeValueInsideDoubleQuotesRegex = /[\n\"\\]/g;
function escapeSelectorAttributeValueInsideDoubleQuotes(value) {
  return value.replace(
    escapeSelectorAttributeValueInsideDoubleQuotesRegex,
    (ch) => "\\" + ch.charCodeAt(0).toString(16)
  );
}
