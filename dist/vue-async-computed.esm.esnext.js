function setAsyncState (vm, stateObject, state) {
  vm.$set(vm.$data._asyncComputed[stateObject], 'state', state);
  vm.$set(vm.$data._asyncComputed[stateObject], 'updating', state === 'updating');
  vm.$set(vm.$data._asyncComputed[stateObject], 'error', state === 'error');
  vm.$set(vm.$data._asyncComputed[stateObject], 'success', state === 'success');
}

function getterOnly (fn) {
  if (typeof fn === 'function') return fn

  return fn.get
}

function hasOwnProperty (object, property) {
  return Object.prototype.hasOwnProperty.call(object, property)
}

function isComputedLazy (item) {
  return hasOwnProperty(item, 'lazy') && item.lazy
}

function isLazyActive (vm, key) {
  return vm[lazyActivePrefix + key]
}

const lazyActivePrefix = 'async_computed$lazy_active$',
      lazyDataPrefix = 'async_computed$lazy_data$';

function initLazy (data, key, value) {
  data[lazyActivePrefix + key] = false;
  data[lazyDataPrefix + key] = value;
}

function makeLazyComputed (key) {
  return {
    get () {
      this[lazyActivePrefix + key] = true;
      return this[lazyDataPrefix + key]
    },
    set (value) {
      this[lazyDataPrefix + key] = value;
    }
  }
}

function silentSetLazy (vm, key, value) {
  vm[lazyDataPrefix + key] = value;
}
function silentGetLazy (vm, key) {
  return vm[lazyDataPrefix + key]
}

const getGetterWatchedByArray = computedAsyncProperty =>
  function getter () {
    computedAsyncProperty.watch.forEach(key => {
      // Check if nested key is watched.
      const splittedByDot = key.split('.');
      if (splittedByDot.length === 1) {
        // If not, just access it.
        // eslint-disable-next-line no-unused-expressions
        this[key];
      } else {
        // Access the nested propety.
        try {
          let start = this;
          splittedByDot.forEach(part => {
            start = start[part];
          });
        } catch (error) {
          console.error('AsyncComputed: bad path: ', key);
          throw error
        }
      }
    });
    return computedAsyncProperty.get.call(this)
  };

const getGetterWatchedByFunction = computedAsyncProperty =>
  function getter () {
    computedAsyncProperty.watch.call(this);
    return computedAsyncProperty.get.call(this)
  };

function getWatchedGetter (computedAsyncProperty) {
  if (typeof computedAsyncProperty.watch === 'function') {
    return getGetterWatchedByFunction(computedAsyncProperty)
  } else if (Array.isArray(computedAsyncProperty.watch)) {
    computedAsyncProperty.watch.forEach(key => {
      if (typeof key !== 'string') {
        throw new Error('AsyncComputed: watch elemnts must be strings')
      }
    });
    return getGetterWatchedByArray(computedAsyncProperty)
  } else {
    throw Error('AsyncComputed: watch should be function or an array')
  }
}

const DidNotUpdate = typeof Symbol === 'function' ? Symbol('did-not-update') : {};

const getGetterWithShouldUpdate = (asyncProprety, currentGetter) => {
  return function getter () {
    return (asyncProprety.shouldUpdate.call(this))
      ? currentGetter.call(this)
      : DidNotUpdate
  }
};

const shouldNotUpdate = (value) => DidNotUpdate === value;

const prefix = '_async_computed$';

const AsyncComputed = {
  install (Vue, pluginOptions) {
    Vue.config
      .optionMergeStrategies
      .asyncComputed = Vue.config.optionMergeStrategies.computed;

    Vue.mixin(getAsyncComputedMixin(pluginOptions));
  }
};

function getAsyncComputedMixin (pluginOptions = {}) {
  return {
    data () {
      return {
        _asyncComputed: {},
      }
    },
    computed: {
      $asyncComputed () {
        return this.$data._asyncComputed
      }
    },
    beforeCreate () {
      const asyncComputed = this.$options.asyncComputed || {};

      if (!Object.keys(asyncComputed).length) return

      for (const key in asyncComputed) {
        const getter = getterFn(key, asyncComputed[key]);
        this.$options.computed[prefix + key] = getter;
      }

      this.$options.data = initDataWithAsyncComputed(this.$options, pluginOptions);
    },
    created () {
      for (const key in this.$options.asyncComputed || {}) {
        const item = this.$options.asyncComputed[key],
              value = generateDefault.call(this, item, pluginOptions);
        if (isComputedLazy(item)) {
          silentSetLazy(this, key, value);
        } else {
          this[key] = value;
        }
      }

      for (const key in this.$options.asyncComputed || {}) {
        handleAsyncComputedPropetyChanges(this, key, pluginOptions);
      }
    }
  }
}
const AsyncComputedMixin = getAsyncComputedMixin();

function handleAsyncComputedPropetyChanges (vm, key, pluginOptions) {
  let promiseId = 0;
  const watcher = newPromise => {
    const thisPromise = ++promiseId;

    if (shouldNotUpdate(newPromise)) return

    if (!newPromise || !newPromise.then) {
      newPromise = Promise.resolve(newPromise);
    }
    setAsyncState(vm, key, 'updating');

    newPromise.then(value => {
      if (thisPromise !== promiseId) return
      setAsyncState(vm, key, 'success');
      vm[key] = value;
    }).catch(err => {
      if (thisPromise !== promiseId) return

      setAsyncState(vm, key, 'error');
      vm.$set(vm.$data._asyncComputed[key], 'exception', err);
      if (pluginOptions.errorHandler === false) return

      const handler = (pluginOptions.errorHandler === undefined)
        ? console.error.bind(console, 'Error evaluating async computed property:')
        : pluginOptions.errorHandler;

      if (pluginOptions.useRawError) {
        handler(err, vm, err.stack);
      } else {
        handler(err.stack);
      }
    });
  };
  vm.$set(vm.$data._asyncComputed, key, {
    exception: null,
    update: () => {
      if (!vm._isDestroyed) {
        watcher(getterOnly(vm.$options.asyncComputed[key]).apply(vm));
      }
    }
  });
  setAsyncState(vm, key, 'updating');
  vm.$watch(prefix + key, watcher, { immediate: true });
}

function initDataWithAsyncComputed (options, pluginOptions) {
  const optionData = options.data;
  const asyncComputed = options.asyncComputed || {};

  return function vueAsyncComputedInjectedDataFn (vm) {
    const data = ((typeof optionData === 'function')
      ? optionData.call(this, vm)
      : optionData) || {};
    for (const key in asyncComputed) {
      const item = this.$options.asyncComputed[key];

      var value = generateDefault.call(this, item, pluginOptions);
      if (isComputedLazy(item)) {
        initLazy(data, key, value);
        this.$options.computed[key] = makeLazyComputed(key);
      } else {
        data[key] = value;
      }
    }
    return data
  }
}

function getterFn (key, fn) {
  if (typeof fn === 'function') return fn

  let getter = fn.get;

  if (hasOwnProperty(fn, 'watch')) {
    getter = getWatchedGetter(fn);
  }

  if (hasOwnProperty(fn, 'shouldUpdate')) {
    getter = getGetterWithShouldUpdate(fn, getter);
  }

  if (isComputedLazy(fn)) {
    const nonLazy = getter;
    getter = function lazyGetter () {
      if (isLazyActive(this, key)) {
        return nonLazy.call(this)
      } else {
        return silentGetLazy(this, key)
      }
    };
  }
  return getter
}

function generateDefault (fn, pluginOptions) {
  let defaultValue = null;

  if ('default' in fn) {
    defaultValue = fn.default;
  } else if ('default' in pluginOptions) {
    defaultValue = pluginOptions.default;
  }

  if (typeof defaultValue === 'function') {
    return defaultValue.call(this)
  } else {
    return defaultValue
  }
}

/* istanbul ignore if */
if (typeof window !== 'undefined' && window.Vue) {
  // Auto install in dist mode
  window.Vue.use(AsyncComputed);
}

export default AsyncComputed;
export { AsyncComputedMixin, AsyncComputed as AsyncComputedPlugin };
